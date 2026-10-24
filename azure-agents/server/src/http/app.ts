import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db, Tx } from "../db/pool.js";
import { logActivity, withTenant } from "../db/pool.js";
import { authenticate, issueToken, memberships, safeEqual, type AuthUser, type Membership } from "../auth.js";
import { SECRET, type SecretStore } from "../secrets.js";
import type { Fetch } from "../azure/client.js";
import { azureClientFor, syncTenant, syncWorkItem, upsertWorkItems } from "../sync/sync.js";
import { queueAssignedWork } from "../agents/dispatch.js";
import { MCP_CATALOG, SKILL_CATALOG, suggestSkills } from "../agents/catalog.js";

export interface AppDeps {
  db: Db;
  secrets: SecretStore;
  fetch?: Fetch;
}

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    membership?: Membership;
  }
}

const providerSchema = z.enum(["claude", "openai", "gemini"]);
const agentSchema = z.object({
  name: z.string().min(1).max(100),
  provider: providerSchema,
  model: z.string().max(100).nullable().optional(),
  instructions: z.string().max(20_000).default(""),
  pairedUniqueName: z.string().email().transform((value) => value.toLowerCase()).nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  maxConcurrentRuns: z.number().int().min(1).max(10).default(1),
  enabled: z.boolean().default(true),
});
const skillSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(60),
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  content: z.string().min(1).max(50_000),
});
const mcpSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).max(60),
  transport: z.enum(["stdio", "http"]),
  command: z.string().max(500).nullable().optional(),
  args: z.array(z.string().max(500)).max(30).default([]),
  url: z.string().url().nullable().optional(),
  envSecretNames: z.array(z.string().regex(/^[A-Z0-9_]+$/)).max(20).default([]),
});

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(422, result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  return result.data;
}

const camel = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]));

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const { db, secrets } = deps;

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error instanceof HttpError ? error.statusCode : error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    void reply.status(status).send({ error: status === 500 ? "Internal server error" : error.message });
    if (status === 500) console.error(error);
  });

  const requireUser = async (request: FastifyRequest) => {
    const user = await authenticate(db, request.headers.authorization);
    if (!user) throw new HttpError(401, "Missing or invalid token");
    request.user = user;
  };

  const requireMember = (role?: "admin") => async (request: FastifyRequest) => {
    await requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const membership = (await memberships(db, request.user!.id)).find((m) => m.tenantId === tenantId);
    if (!membership) throw new HttpError(403, "Not a member of this tenant");
    if (role === "admin" && membership.role !== "admin") throw new HttpError(403, "Admin role required");
    request.membership = membership;
  };

  const tenantTx = <T>(request: FastifyRequest, fn: (tx: Tx, tenantId: string) => Promise<T>) =>
    withTenant(db, request.membership!.tenantId, (tx) => fn(tx, request.membership!.tenantId));

  const actor = (request: FastifyRequest) => `user:${request.user!.email}`;
  const member = { preHandler: requireMember() };
  const admin = { preHandler: requireMember("admin") };

  // Setup and identity ---------------------------------------------------------------

  app.post("/api/setup", async (request) => {
    const body = parse(z.object({ tenantName: z.string().min(1), email: z.string().email(), name: z.string().min(1) }), request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE users IN EXCLUSIVE MODE");
      const { rows: [{ count }] } = await client.query<{ count: string }>("SELECT count(*) FROM users");
      if (Number(count) > 0) throw new HttpError(409, "Setup has already been completed");
      const { rows: [user] } = await client.query<{ id: string }>("INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id", [body.email.toLowerCase(), body.name]);
      const slug = body.tenantName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tenant";
      const { rows: [tenant] } = await client.query<{ id: string }>("INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id", [body.tenantName, slug]);
      await client.query("INSERT INTO tenant_members (tenant_id, user_id, role, azure_unique_name) VALUES ($1, $2, 'admin', $3)",
        [tenant!.id, user!.id, body.email.toLowerCase()]);
      await client.query("COMMIT");
      return { tenantId: tenant!.id, token: await issueToken(db, user!.id, "setup") };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/api/me", { preHandler: requireUser }, async (request) => ({
    user: request.user,
    memberships: await memberships(db, request.user!.id),
  }));

  app.post("/api/tenants", { preHandler: requireUser }, async (request) => {
    const body = parse(z.object({ name: z.string().min(1).max(100) }), request.body);
    const slug = `${body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
    const { rows: [tenant] } = await db.query<{ id: string }>("INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id", [body.name, slug]);
    await db.query("INSERT INTO tenant_members (tenant_id, user_id, role, azure_unique_name) VALUES ($1, $2, 'admin', $3)",
      [tenant!.id, request.user!.id, request.user!.email]);
    return { tenantId: tenant!.id };
  });

  // Members --------------------------------------------------------------------------

  app.get("/api/t/:tenantId/members", member, async (request) => {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.name, m.role, m.azure_unique_name FROM tenant_members m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 ORDER BY u.name`, [request.membership!.tenantId]);
    return rows.map(camel);
  });

  app.post("/api/t/:tenantId/members", admin, async (request) => {
    const body = parse(z.object({
      email: z.string().email(), name: z.string().min(1), role: z.enum(["admin", "member"]).default("member"),
      azureUniqueName: z.string().email().optional(),
    }), request.body);
    const email = body.email.toLowerCase();
    const { rows: [user] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name = users.name RETURNING id`, [email, body.name]);
    await db.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, azure_unique_name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, azure_unique_name = EXCLUDED.azure_unique_name`,
      [request.membership!.tenantId, user!.id, body.role, (body.azureUniqueName ?? email).toLowerCase()]);
    return { userId: user!.id, token: await issueToken(db, user!.id, `invite:${request.membership!.tenantId}`) };
  });

  app.put("/api/t/:tenantId/me", member, async (request) => {
    const body = parse(z.object({ azureUniqueName: z.string().email() }), request.body);
    await db.query("UPDATE tenant_members SET azure_unique_name = $3 WHERE tenant_id = $1 AND user_id = $2",
      [request.membership!.tenantId, request.user!.id, body.azureUniqueName.toLowerCase()]);
    return { ok: true };
  });

  // Azure connection and secrets -----------------------------------------------------

  app.get("/api/t/:tenantId/connection", member, (request) => tenantTx(request, async (tx) => {
    const { rows: [row] } = await tx.query("SELECT organization_url, project, review_state, last_sync_at, last_sync_error FROM azure_connections");
    return { connection: row ? camel(row) : null, secrets: await secrets.list(tx) };
  }));

  app.put("/api/t/:tenantId/connection", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const body = parse(z.object({
      organizationUrl: z.string().url().refine((url) => /^https:\/\/(dev\.azure\.com\/[^/]+|[a-z0-9-]+\.visualstudio\.com)\/?$/i.test(url),
        "Use https://dev.azure.com/<org> or https://<org>.visualstudio.com"),
      project: z.string().min(1).max(200),
      reviewState: z.string().max(50).nullable().optional(),
      pat: z.string().min(10).optional(),
      webhookSecret: z.string().min(16).optional(),
    }), request.body);
    await tx.query(
      `INSERT INTO azure_connections (tenant_id, organization_url, project, review_state) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE SET organization_url = EXCLUDED.organization_url, project = EXCLUDED.project,
         review_state = EXCLUDED.review_state, updated_at = now()`,
      [tenantId, body.organizationUrl.replace(/\/+$/, ""), body.project, body.reviewState ?? null]);
    if (body.pat) await secrets.set(tx, tenantId, SECRET.azurePat, body.pat);
    if (body.webhookSecret) await secrets.set(tx, tenantId, SECRET.webhookSecret, body.webhookSecret);
    await logActivity(tx, tenantId, { actor: actor(request), action: "connection.updated", entityType: "tenant", entityId: tenantId,
      details: { organizationUrl: body.organizationUrl, project: body.project, patChanged: Boolean(body.pat) } });
    return { ok: true };
  }));

  app.put("/api/t/:tenantId/secrets/:name", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const { name } = parse(z.object({ name: z.string().regex(/^[A-Z0-9_]+$/).max(80) }), request.params);
    const { value } = parse(z.object({ value: z.string().min(1).max(10_000) }), request.body);
    await secrets.set(tx, tenantId, name, value);
    await logActivity(tx, tenantId, { actor: actor(request), action: "secret.set", entityType: "secret", entityId: name });
    return { ok: true };
  }));

  app.delete("/api/t/:tenantId/secrets/:name", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const { name } = request.params as { name: string };
    await secrets.remove(tx, name);
    await logActivity(tx, tenantId, { actor: actor(request), action: "secret.removed", entityType: "secret", entityId: name });
    return { ok: true };
  }));

  app.post("/api/t/:tenantId/connection/test", admin, (request) => tenantTx(request, async (tx) => {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    try {
      const connection = await azureClientFor(tx, deps);
      if (!connection) return { ok: false, checks: [{ name: "connection", ok: false, detail: "Save the organization URL and project first" }] };
      const project = await connection.client.getProject();
      checks.push({ name: "project", ok: true, detail: project.name });
      const teams = await connection.client.listTeams();
      checks.push({ name: "teams", ok: true, detail: teams.map((team) => team.name).join(", ") || "none" });
      const repos = await connection.client.listRepositories();
      checks.push({ name: "repositories", ok: true, detail: repos.map((repo) => repo.name).join(", ") || "none" });
    } catch (error) {
      checks.push({ name: "azure", ok: false, detail: (error as Error).message });
    }
    return { ok: checks.every((check) => check.ok), checks };
  }));

  app.post("/api/t/:tenantId/sync", admin, async (request) => ({ result: await syncTenant(deps, request.membership!.tenantId) }));

  // Board ----------------------------------------------------------------------------

  app.get("/api/t/:tenantId/teams", member, (request) => tenantTx(request, async (tx) => {
    const { rows } = await tx.query(
      `SELECT t.id, t.name, coalesce(json_agg(json_build_object('uniqueName', m.unique_name, 'displayName', m.display_name,
          'agentId', a.id, 'agentName', a.name) ORDER BY m.display_name) FILTER (WHERE m.unique_name IS NOT NULL), '[]') AS members
         FROM teams t LEFT JOIN team_members m ON m.team_id = t.id LEFT JOIN agents a ON a.paired_unique_name = m.unique_name
        GROUP BY t.id ORDER BY t.name`);
    return rows;
  }));

  app.get("/api/t/:tenantId/work-items", member, (request) => tenantTx(request, async (tx) => {
    const query = parse(z.object({
      assignedTo: z.string().optional(), state: z.string().optional(), search: z.string().max(200).optional(),
      iteration: z.string().optional(),
    }), request.query);
    const { rows } = await tx.query(
      `SELECT w.azure_id, w.type, w.title, w.state, w.assigned_to_unique_name, w.assigned_to_display_name, w.priority,
              w.tags, w.repo_names, w.iteration_path, w.area_path, w.web_url, w.changed_at,
              r.status AS run_status, a.name AS agent_name
         FROM work_items w
         LEFT JOIN LATERAL (SELECT status, agent_id FROM agent_runs WHERE work_item_id = w.id ORDER BY created_at DESC LIMIT 1) r ON true
         LEFT JOIN agents a ON a.id = r.agent_id
        WHERE ($1::text IS NULL OR w.assigned_to_unique_name = lower($1))
          AND ($2::text IS NULL OR w.state = $2)
          AND ($3::text IS NULL OR w.title ILIKE '%' || $3 || '%' OR w.azure_id::text = $3)
          AND ($4::text IS NULL OR w.iteration_path = $4)
        ORDER BY w.changed_at DESC LIMIT 500`,
      [query.assignedTo === "me" ? request.membership!.azureUniqueName : query.assignedTo ?? null,
        query.state ?? null, query.search ?? null, query.iteration ?? null]);
    return rows.map(camel);
  }));

  app.get("/api/t/:tenantId/work-items/:azureId", member, (request) => tenantTx(request, async (tx) => {
    const { azureId } = parse(z.object({ azureId: z.coerce.number().int() }), request.params);
    const { rows: [item] } = await tx.query("SELECT * FROM work_items WHERE azure_id = $1", [azureId]);
    if (!item) throw new HttpError(404, "Work item not found");
    const runs = await tx.query(
      `SELECT r.id, r.status, r.branch, r.pull_request_urls, r.error, r.created_at, r.started_at, r.finished_at, a.name AS agent_name
         FROM agent_runs r JOIN agents a ON a.id = r.agent_id WHERE r.work_item_id = $1 ORDER BY r.created_at DESC`, [item.id]);
    const prs = await tx.query(
      `SELECT p.azure_pr_id, p.title, p.status, p.source_branch, p.target_branch, p.created_by, p.created_at, p.web_url, r.name AS repository
         FROM pull_requests p JOIN repositories r ON r.id = p.repository_id WHERE $1 = ANY(p.work_item_azure_ids) ORDER BY p.created_at DESC`, [azureId]);
    const commits = await tx.query(
      `SELECT c.commit_id, c.author_name, c.message, c.committed_at, c.web_url, r.name AS repository
         FROM commits c JOIN repositories r ON r.id = c.repository_id
        WHERE c.message ~* ('AB#' || $1::text || '([^0-9]|$)') ORDER BY c.committed_at DESC LIMIT 100`, [azureId]);
    return { item: camel(item), runs: runs.rows.map(camel), pullRequests: prs.rows.map(camel), commits: commits.rows.map(camel) };
  }));

  app.post("/api/t/:tenantId/work-items/:azureId/assign", member, (request) => tenantTx(request, async (tx, tenantId) => {
    const { azureId } = parse(z.object({ azureId: z.coerce.number().int() }), request.params);
    const body = parse(z.object({ to: z.union([z.literal("me"), z.literal(""), z.string().email()]) }), request.body);
    const uniqueName = body.to === "me" ? request.membership!.azureUniqueName : body.to;
    if (body.to === "me" && !uniqueName) throw new HttpError(422, "Set your Azure DevOps identity first");
    const connection = await azureClientFor(tx, deps);
    if (!connection) throw new HttpError(409, "Azure DevOps is not connected");
    // Azure stays the source of truth: write there, then mirror the returned revision.
    const updated = await connection.client.updateWorkItemFields(azureId, { "System.AssignedTo": uniqueName || "" });
    await upsertWorkItems(tx, tenantId, connection.client, await connection.client.getWorkItems([updated.id]));
    const queued = await queueAssignedWork(tx, tenantId);
    await logActivity(tx, tenantId, { actor: actor(request), action: "work_item.assigned", entityType: "work_item", entityId: String(azureId),
      details: { to: uniqueName || null } });
    return { ok: true, queuedRuns: queued };
  }));

  // Repositories ---------------------------------------------------------------------

  app.get("/api/t/:tenantId/repositories", member, (request) => tenantTx(request, async (tx) => {
    const { rows } = await tx.query(
      `SELECT r.id, r.name, r.default_branch, r.web_url,
              (SELECT count(*) FROM pull_requests p WHERE p.repository_id = r.id AND p.status = 'active')::int AS open_pull_requests,
              (SELECT max(committed_at) FROM commits c WHERE c.repository_id = r.id) AS last_commit_at
         FROM repositories r ORDER BY r.name`);
    return rows.map(camel);
  }));

  app.get("/api/t/:tenantId/repositories/:id/commits", member, (request) => tenantTx(request, async (tx) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { rows } = await tx.query(
      "SELECT commit_id, author_name, author_email, message, committed_at, web_url FROM commits WHERE repository_id = $1 ORDER BY committed_at DESC LIMIT 200", [id]);
    return rows.map(camel);
  }));

  app.get("/api/t/:tenantId/pull-requests", member, (request) => tenantTx(request, async (tx) => {
    const query = parse(z.object({ status: z.enum(["active", "completed", "abandoned"]).optional(), repositoryId: z.string().uuid().optional() }), request.query);
    const { rows } = await tx.query(
      `SELECT p.azure_pr_id, p.title, p.status, p.source_branch, p.target_branch, p.created_by, p.created_at, p.closed_at,
              p.web_url, p.work_item_azure_ids, r.name AS repository
         FROM pull_requests p JOIN repositories r ON r.id = p.repository_id
        WHERE ($1::text IS NULL OR p.status = $1) AND ($2::uuid IS NULL OR p.repository_id = $2)
        ORDER BY p.created_at DESC LIMIT 300`, [query.status ?? null, query.repositoryId ?? null]);
    return rows.map(camel);
  }));

  // Agents, skills, MCP --------------------------------------------------------------

  app.get("/api/t/:tenantId/agents", member, (request) => tenantTx(request, async (tx) => {
    const { rows } = await tx.query(
      `SELECT a.*, t.name AS team_name,
              coalesce((SELECT json_agg(s.key ORDER BY s.key) FROM agent_skills x JOIN skills s ON s.id = x.skill_id WHERE x.agent_id = a.id), '[]') AS skills,
              coalesce((SELECT json_agg(m.name ORDER BY m.name) FROM agent_mcp_servers x JOIN mcp_servers m ON m.id = x.mcp_server_id WHERE x.agent_id = a.id), '[]') AS mcp_servers,
              (SELECT count(*) FROM agent_runs r WHERE r.agent_id = a.id AND r.status = 'running')::int AS running_runs
         FROM agents a LEFT JOIN teams t ON t.id = a.team_id ORDER BY a.name`);
    return rows.map(camel);
  }));

  const saveAgent = async (tx: Tx, tenantId: string, body: z.infer<typeof agentSchema>, id?: string) => {
    const values = [body.name, body.provider, body.model ?? null, body.instructions, body.pairedUniqueName ?? null,
      body.teamId ?? null, body.maxConcurrentRuns, body.enabled];
    const { rows: [row] } = id
      ? await tx.query(`UPDATE agents SET name=$1, provider=$2, model=$3, instructions=$4, paired_unique_name=$5, team_id=$6,
          max_concurrent_runs=$7, enabled=$8 WHERE id=$9 RETURNING id`, [...values, id])
      : await tx.query(`INSERT INTO agents (name, provider, model, instructions, paired_unique_name, team_id, max_concurrent_runs, enabled, tenant_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [...values, tenantId]);
    if (!row) throw new HttpError(404, "Agent not found");
    return row.id as string;
  };

  app.post("/api/t/:tenantId/agents", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const id = await saveAgent(tx, tenantId, parse(agentSchema, request.body));
    await logActivity(tx, tenantId, { actor: actor(request), action: "agent.created", entityType: "agent", entityId: id });
    return { id, queuedRuns: await queueAssignedWork(tx, tenantId) };
  }));

  app.put("/api/t/:tenantId/agents/:id", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    await saveAgent(tx, tenantId, parse(agentSchema, request.body), id);
    await logActivity(tx, tenantId, { actor: actor(request), action: "agent.updated", entityType: "agent", entityId: id });
    return { id, queuedRuns: await queueAssignedWork(tx, tenantId) };
  }));

  app.delete("/api/t/:tenantId/agents/:id", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    await tx.query("DELETE FROM agents WHERE id = $1", [id]);
    await logActivity(tx, tenantId, { actor: actor(request), action: "agent.deleted", entityType: "agent", entityId: id });
    return { ok: true };
  }));

  /** One agent per team member who has none yet. */
  app.post("/api/t/:tenantId/teams/:teamId/provision-agents", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const { teamId } = parse(z.object({ teamId: z.string().uuid() }), request.params);
    const body = parse(z.object({ provider: providerSchema.default("claude"), model: z.string().nullable().optional() }), request.body ?? {});
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, name, provider, model, paired_unique_name, team_id)
       SELECT $1, m.display_name || ' (agent)', $3, $4, m.unique_name, m.team_id FROM team_members m
        WHERE m.team_id = $2 AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.paired_unique_name = m.unique_name)
       RETURNING id`, [tenantId, teamId, body.provider, body.model ?? null]);
    await logActivity(tx, tenantId, { actor: actor(request), action: "agents.provisioned", entityType: "team", entityId: teamId,
      details: { created: rows.length } });
    return { created: rows.length, queuedRuns: await queueAssignedWork(tx, tenantId) };
  }));

  app.put("/api/t/:tenantId/agents/:id/skills", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { skillKeys } = parse(z.object({ skillKeys: z.array(z.string()).max(50) }), request.body);
    await tx.query("DELETE FROM agent_skills WHERE agent_id = $1", [id]);
    await tx.query(`INSERT INTO agent_skills (tenant_id, agent_id, skill_id) SELECT $1, $2, id FROM skills WHERE key = ANY($3)`, [tenantId, id, skillKeys]);
    return { ok: true };
  }));

  app.put("/api/t/:tenantId/agents/:id/mcp-servers", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { names } = parse(z.object({ names: z.array(z.string()).max(20) }), request.body);
    await tx.query("DELETE FROM agent_mcp_servers WHERE agent_id = $1", [id]);
    await tx.query(`INSERT INTO agent_mcp_servers (tenant_id, agent_id, mcp_server_id) SELECT $1, $2, id FROM mcp_servers WHERE name = ANY($3)`, [tenantId, id, names]);
    return { ok: true };
  }));

  app.get("/api/t/:tenantId/skills", member, (request) => tenantTx(request, async (tx) =>
    (await tx.query("SELECT id, key, name, description, content FROM skills ORDER BY key")).rows));

  app.put("/api/t/:tenantId/skills/:key", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const body = parse(skillSchema, { ...(request.body as object), key: (request.params as { key: string }).key });
    await tx.query(`INSERT INTO skills (tenant_id, key, name, description, content) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id, key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, content = EXCLUDED.content`,
      [tenantId, body.key, body.name, body.description, body.content]);
    return { ok: true };
  }));

  app.delete("/api/t/:tenantId/skills/:key", admin, (request) => tenantTx(request, async (tx) => {
    await tx.query("DELETE FROM skills WHERE key = $1", [(request.params as { key: string }).key]);
    return { ok: true };
  }));

  app.get("/api/t/:tenantId/catalog", member, () => ({
    skills: SKILL_CATALOG.map(({ signals: _signals, ...skill }) => skill),
    mcpServers: MCP_CATALOG,
  }));

  app.get("/api/t/:tenantId/skills/suggestions", member, (request) => tenantTx(request, async (tx) => {
    const connection = await azureClientFor(tx, deps);
    if (!connection) return [];
    const installed = (await tx.query<{ key: string }>("SELECT key FROM skills")).rows.map((row) => row.key);
    const repos = (await tx.query<{ name: string }>("SELECT name FROM repositories WHERE default_branch IS NOT NULL ORDER BY name LIMIT 50")).rows;
    const filesByRepo: Record<string, string[]> = {};
    for (const repo of repos) filesByRepo[repo.name] = await connection.client.listRootFiles(repo.name).catch(() => []);
    return suggestSkills(filesByRepo, installed);
  }));

  app.get("/api/t/:tenantId/mcp-servers", member, (request) => tenantTx(request, async (tx) =>
    (await tx.query("SELECT id, name, transport, command, args, url, env_secret_names FROM mcp_servers ORDER BY name")).rows.map(camel)));

  app.put("/api/t/:tenantId/mcp-servers/:name", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const body = parse(mcpSchema, { ...(request.body as object), name: (request.params as { name: string }).name });
    await tx.query(`INSERT INTO mcp_servers (tenant_id, name, transport, command, args, url, env_secret_names) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id, name) DO UPDATE SET transport = EXCLUDED.transport, command = EXCLUDED.command, args = EXCLUDED.args,
        url = EXCLUDED.url, env_secret_names = EXCLUDED.env_secret_names`,
      [tenantId, body.name, body.transport, body.command ?? null, JSON.stringify(body.args), body.url ?? null, JSON.stringify(body.envSecretNames)]);
    return { ok: true };
  }));

  app.delete("/api/t/:tenantId/mcp-servers/:name", admin, (request) => tenantTx(request, async (tx) => {
    await tx.query("DELETE FROM mcp_servers WHERE name = $1", [(request.params as { name: string }).name]);
    return { ok: true };
  }));

  // Runs and activity ----------------------------------------------------------------

  app.get("/api/t/:tenantId/runs", member, (request) => tenantTx(request, async (tx) => {
    const { rows } = await tx.query(
      `SELECT r.id, r.status, r.branch, r.pull_request_urls, r.error, r.created_at, r.started_at, r.finished_at,
              a.name AS agent_name, w.azure_id, w.title
         FROM agent_runs r JOIN agents a ON a.id = r.agent_id JOIN work_items w ON w.id = r.work_item_id
        ORDER BY r.created_at DESC LIMIT 200`);
    return rows.map(camel);
  }));

  app.get("/api/t/:tenantId/runs/:id", member, (request) => tenantTx(request, async (tx) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { rows: [run] } = await tx.query("SELECT * FROM agent_runs WHERE id = $1", [id]);
    if (!run) throw new HttpError(404, "Run not found");
    return camel(run);
  }));

  app.post("/api/t/:tenantId/runs/:id/retry", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { rows: [run] } = await tx.query<{ id: string }>(
      `INSERT INTO agent_runs (tenant_id, agent_id, work_item_id, status)
       SELECT tenant_id, agent_id, work_item_id, 'queued' FROM agent_runs WHERE id = $1 AND status IN ('failed', 'cancelled')
       ON CONFLICT DO NOTHING RETURNING id`, [id]);
    if (!run) throw new HttpError(409, "Only failed or cancelled runs can be retried, and only when none is active");
    await logActivity(tx, tenantId, { actor: actor(request), action: "run.retried", entityType: "run", entityId: run.id, details: { from: id } });
    return { id: run.id };
  }));

  app.post("/api/t/:tenantId/runs/:id/cancel", admin, (request) => tenantTx(request, async (tx, tenantId) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const result = await tx.query("UPDATE agent_runs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued'", [id]);
    if (!result.rowCount) throw new HttpError(409, "Only queued runs can be cancelled");
    await logActivity(tx, tenantId, { actor: actor(request), action: "run.cancelled", entityType: "run", entityId: id });
    return { ok: true };
  }));

  app.get("/api/t/:tenantId/activity", member, (request) => tenantTx(request, async (tx) =>
    (await tx.query("SELECT actor, action, entity_type, entity_id, details, created_at FROM activity ORDER BY created_at DESC LIMIT 200")).rows.map(camel)));

  // Azure Service Hooks --------------------------------------------------------------

  app.post("/api/hooks/:tenantId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenantId } = parse(z.object({ tenantId: z.string().uuid() }), request.params);
    const password = (() => {
      const basic = request.headers.authorization?.match(/^Basic\s+(\S+)$/i)?.[1];
      return basic ? Buffer.from(basic, "base64").toString("utf8").split(":").slice(1).join(":") : "";
    })();
    const expected = await withTenant(db, tenantId, (tx) => secrets.get(tx, SECRET.webhookSecret)).catch(() => null);
    if (!expected || !safeEqual(password, expected)) return reply.status(401).send({ error: "Invalid webhook credentials" });
    const event = request.body as { eventType?: string; resource?: { id?: number; workItemId?: number } };
    const eventType = event?.eventType ?? "";
    if (eventType.startsWith("workitem.")) {
      const azureId = Number(event.resource?.workItemId ?? event.resource?.id);
      if (Number.isInteger(azureId)) await syncWorkItem(deps, tenantId, azureId);
    } else if (eventType.startsWith("git.")) {
      // Pushes and pull request changes refresh commits/PRs in the background.
      void syncTenant(deps, tenantId).catch((error) => console.error("hook sync failed", error));
    }
    return { ok: true };
  });

  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  return app;
}

