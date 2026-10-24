import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db/pool.js";
import { listTenantIds, logActivity, withTenant } from "../db/pool.js";
import { branchName } from "../azure/mapping.js";
import { SECRET, type SecretStore } from "../secrets.js";
import { azureClientFor } from "../sync/sync.js";
import type { Fetch } from "../azure/client.js";
import { scrub, spawnExec, type Exec } from "./exec.js";
import { buildInvocation, buildPrompt, PROVIDER_KEY_SECRET, type Provider, type ResolvedMcpServer, type ResolvedSkill } from "./providers.js";

export interface RunnerDeps {
  db: Db;
  secrets: SecretStore;
  workspaceRoot: string;
  timeoutMs: number;
  exec?: Exec;
  fetch?: Fetch;
}

interface RunContext {
  tenantId: string;
  runId: string;
  agent: { id: string; name: string; provider: Provider; model: string | null; instructions: string };
  workItem: { id: string; azureId: number; type: string; title: string; descriptionHtml: string; webUrl: string; repoNames: string[] };
  repositories: Array<{ name: string; remoteUrl: string; defaultBranch: string }>;
  skills: ResolvedSkill[];
  mcpServers: ResolvedMcpServer[];
  organizationUrl: string;
  reviewState: string | null;
  pat: string;
  apiKey: string | null;
}

/** Claims the oldest queued run whose agent is below its concurrency limit. */
export async function claimRun(db: Db, tenantId: string): Promise<string | null> {
  return withTenant(db, tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE agent_runs SET status = 'running', started_at = now()
        WHERE id = (
          SELECT r.id FROM agent_runs r JOIN agents a ON a.id = r.agent_id
           WHERE r.status = 'queued' AND a.enabled
             AND (SELECT count(*) FROM agent_runs x WHERE x.agent_id = a.id AND x.status = 'running') < a.max_concurrent_runs
           ORDER BY r.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1)
        RETURNING id`,
    );
    return rows[0]?.id ?? null;
  });
}

async function loadContext(deps: RunnerDeps, tenantId: string, runId: string): Promise<RunContext> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const { rows: [row] } = await tx.query(
      `SELECT a.id AS agent_id, a.name, a.provider, a.model, a.instructions,
              w.id AS work_item_id, w.azure_id, w.type, w.title, w.description_html, w.web_url, w.repo_names,
              c.organization_url, c.review_state
         FROM agent_runs r JOIN agents a ON a.id = r.agent_id JOIN work_items w ON w.id = r.work_item_id
         CROSS JOIN azure_connections c WHERE r.id = $1`, [runId]);
    if (!row) throw new Error("Run, agent, work item or Azure connection not found");
    const repos = await tx.query<{ name: string; remote_url: string; default_branch: string | null }>(
      "SELECT name, remote_url, default_branch FROM repositories WHERE lower(name) = ANY($1)",
      [(row.repo_names as string[]).map((name) => name.toLowerCase())]);
    const skills = await tx.query<ResolvedSkill>(
      `SELECT s.key, s.name, s.description, s.content FROM skills s JOIN agent_skills x ON x.skill_id = s.id
        WHERE x.agent_id = $1 ORDER BY s.key`, [row.agent_id]);
    const mcp = await tx.query<{ name: string; transport: "stdio" | "http"; command: string | null; args: string[]; url: string | null; env_secret_names: string[] }>(
      `SELECT m.name, m.transport, m.command, m.args, m.url, m.env_secret_names FROM mcp_servers m
         JOIN agent_mcp_servers x ON x.mcp_server_id = m.id WHERE x.agent_id = $1 ORDER BY m.name`, [row.agent_id]);
    const mcpServers: ResolvedMcpServer[] = [];
    for (const server of mcp.rows) {
      const env: Record<string, string> = {};
      for (const name of server.env_secret_names) {
        const value = await deps.secrets.get(tx, name);
        if (value) env[name] = value;
      }
      mcpServers.push({ name: server.name, transport: server.transport, command: server.command, args: server.args, url: server.url, env });
    }
    const pat = await deps.secrets.get(tx, SECRET.azurePat);
    if (!pat) throw new Error(`Secret ${SECRET.azurePat} is not set`);
    return {
      tenantId,
      runId,
      agent: { id: row.agent_id, name: row.name, provider: row.provider, model: row.model, instructions: row.instructions },
      workItem: {
        id: row.work_item_id, azureId: row.azure_id, type: row.type, title: row.title,
        descriptionHtml: row.description_html, webUrl: row.web_url, repoNames: row.repo_names,
      },
      repositories: repos.rows.map((repo) => ({ name: repo.name, remoteUrl: repo.remote_url, defaultBranch: repo.default_branch ?? "main" })),
      skills: skills.rows,
      mcpServers,
      organizationUrl: row.organization_url,
      reviewState: row.review_state,
      pat,
      apiKey: await deps.secrets.get(tx, PROVIDER_KEY_SECRET[row.provider as Provider]),
    };
  });
}

export function htmlToText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6])>/gi, "\n").replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
}

/** Git auth scoped to the organization's origin; the PAT travels in env, never argv. */
export function gitAuthEnv(organizationUrl: string, pat: string): Record<string, string> {
  const origin = new URL(organizationUrl).origin;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
  };
}

async function executeRun(deps: RunnerDeps, context: RunContext, log: string[]): Promise<{ pullRequestUrls: string[]; branch: string }> {
  const exec = deps.exec ?? spawnExec;
  const runDir = path.join(deps.workspaceRoot, context.tenantId, context.runId);
  const branch = branchName(context.workItem.azureId, context.workItem.title);
  const gitEnv = gitAuthEnv(context.organizationUrl, context.pat);
  const identity = ["-c", `user.name=${context.agent.name}`, "-c", `user.email=agent-${context.agent.id}@azure-agents.local`];
  const git = async (cwd: string, args: string[]) => {
    const result = await exec("git", [...identity, ...args], { cwd, env: gitEnv, timeoutMs: 10 * 60_000 });
    log.push(`$ git ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed`);
    return result.stdout.trim();
  };

  if (context.repositories.length === 0) {
    throw new Error(`No known repository on this work item. Tag it repo:<name> (tags: ${context.workItem.repoNames.join(", ") || "none"})`);
  }
  await fs.rm(runDir, { recursive: true, force: true });
  await fs.mkdir(runDir, { recursive: true });
  for (const repo of context.repositories) {
    await git(runDir, ["clone", "--depth", "50", "--branch", repo.defaultBranch, repo.remoteUrl, repo.name]);
    await git(path.join(runDir, repo.name), ["checkout", "-b", branch]);
  }

  const invocation = buildInvocation({
    provider: context.agent.provider,
    model: context.agent.model,
    apiKey: context.apiKey,
    runDir,
    skills: context.skills,
    mcpServers: context.mcpServers,
    prompt: buildPrompt({
      agentInstructions: context.agent.instructions,
      workItem: { ...context.workItem, descriptionText: htmlToText(context.workItem.descriptionHtml) },
      repositories: context.repositories.map((repo) => ({ name: repo.name, dir: repo.name, branch })),
    }),
  });
  for (const file of invocation.files) {
    await fs.mkdir(path.dirname(path.join(runDir, file.path)), { recursive: true });
    await fs.writeFile(path.join(runDir, file.path), file.content);
  }
  const agentResult = await exec(invocation.command, invocation.args, { cwd: runDir, env: invocation.env, timeoutMs: deps.timeoutMs });
  log.push(`$ ${invocation.command} (${context.agent.provider})\n${agentResult.stdout}${agentResult.stderr}`);
  if (agentResult.timedOut) throw new Error("Agent timed out");
  if (agentResult.code !== 0) throw new Error(`Agent CLI exited with code ${agentResult.code}`);

  const { client } = (await withTenant(deps.db, context.tenantId, (tx) => azureClientFor(tx, deps)))!;
  const pullRequestUrls: string[] = [];
  for (const repo of context.repositories) {
    const cwd = path.join(runDir, repo.name);
    if (await git(cwd, ["status", "--porcelain"])) {
      await git(cwd, ["add", "-A"]);
      await git(cwd, ["commit", "-m", `AB#${context.workItem.azureId}: ${context.workItem.title}`]);
    }
    const ahead = Number(await git(cwd, ["rev-list", "--count", `origin/${repo.defaultBranch}..HEAD`]));
    if (!ahead) continue;
    await git(cwd, ["push", "-u", "origin", branch]);
    const pr = await client.createPullRequest({
      repo: repo.name,
      sourceBranch: branch,
      targetBranch: repo.defaultBranch,
      title: `AB#${context.workItem.azureId}: ${context.workItem.title}`,
      description: `Implemented by agent **${context.agent.name}** for ${context.workItem.webUrl}.\n\n${agentResult.stdout.trim().slice(-3000)}`,
      workItemId: context.workItem.azureId,
    });
    const webUrl = pr.repository.webUrl ? client.pullRequestWebUrl(pr.repository.webUrl, pr.pullRequestId) : `PR ${pr.pullRequestId}`;
    pullRequestUrls.push(webUrl);
  }
  if (pullRequestUrls.length === 0) throw new Error("The agent made no changes");
  await client.addWorkItemComment(context.workItem.azureId,
    `Agent ${context.agent.name} opened ${pullRequestUrls.map((url) => `<a href="${url}">${url}</a>`).join(", ")}`);
  if (context.reviewState) await client.updateWorkItemFields(context.workItem.azureId, { "System.State": context.reviewState });
  await fs.rm(runDir, { recursive: true, force: true });
  return { pullRequestUrls, branch };
}

export async function processRun(deps: RunnerDeps, tenantId: string, runId: string): Promise<void> {
  let secrets: Array<string | null> = [];
  const log: string[] = [];
  let outcome: { status: "succeeded" | "failed"; error: string | null; pullRequestUrls: string[]; branch: string | null };
  try {
    const context = await loadContext(deps, tenantId, runId);
    secrets = [context.pat, context.apiKey, Buffer.from(`:${context.pat}`).toString("base64"), ...context.mcpServers.flatMap((s) => Object.values(s.env))];
    const result = await executeRun(deps, context, log);
    outcome = { status: "succeeded", error: null, pullRequestUrls: result.pullRequestUrls, branch: result.branch };
  } catch (error) {
    outcome = { status: "failed", error: (error as Error).message, pullRequestUrls: [], branch: null };
  }
  await withTenant(deps.db, tenantId, async (tx) => {
    await tx.query(
      `UPDATE agent_runs SET status = $2, log = $3, error = $4, pull_request_urls = $5, branch = $6, finished_at = now()
        WHERE id = $1 AND status = 'running'`,
      [runId, outcome.status, scrub(log.join("\n"), secrets).slice(-200_000), outcome.error && scrub(outcome.error, secrets),
        outcome.pullRequestUrls, outcome.branch],
    );
    await logActivity(tx, tenantId, { actor: "runner", action: `run.${outcome.status}`, entityType: "run", entityId: runId,
      details: { error: outcome.error, pullRequests: outcome.pullRequestUrls } });
  });
}

/** One pass: claim and run up to `limit` runs across tenants. */
export async function runQueuedOnce(deps: RunnerDeps, limit: number): Promise<number> {
  const work: Promise<void>[] = [];
  for (const tenantId of await listTenantIds(deps.db)) {
    while (work.length < limit) {
      const runId = await claimRun(deps.db, tenantId);
      if (!runId) break;
      work.push(processRun(deps, tenantId, runId));
    }
  }
  await Promise.all(work);
  return work.length;
}
