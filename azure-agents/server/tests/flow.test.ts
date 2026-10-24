import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, withTenant, type Db } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createSecretStore } from "../src/secrets.js";
import { buildApp } from "../src/http/app.js";
import { runQueuedOnce } from "../src/agents/runner.js";
import { spawnExec, type Exec } from "../src/agents/exec.js";
import { createFakeAzure } from "./fake-azure.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://azagents:azagents@localhost:5432/azagents_test";
const ORG = "https://dev.azure.com/acme";
const PAT = "test-pat-123456";

let db: Db;
let tmp: string;
const secrets = createSecretStore(crypto.randomBytes(32));

async function resetDatabase() {
  const admin = createPool(DATABASE_URL);
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await admin.end();
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
}

beforeAll(async () => {
  await resetDatabase();
  db = createPool(DATABASE_URL);
  await migrate(db);
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "azure-agents-"));
  // A local bare repository stands in for the Azure Repos remote.
  git(tmp, "init", "--bare", "-b", "main", "api.git");
  git(tmp, "clone", path.join(tmp, "api.git"), "seed");
  await fs.writeFile(path.join(tmp, "seed", "README.md"), "# api\n");
  git(path.join(tmp, "seed"), "add", "-A");
  git(path.join(tmp, "seed"), "commit", "-m", "init");
  git(path.join(tmp, "seed"), "push", "origin", "main");
});

afterAll(async () => {
  await db?.end();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("azure-agents end to end", () => {
  const azure = createFakeAzure({ org: ORG, project: "Shop", pat: PAT, repoRemote: () => path.join(tmp, "api.git") });
  let app: ReturnType<typeof buildApp>;
  let token = "";
  let tenantId = "";
  const call = async (method: string, url: string, payload?: unknown, auth = token) => {
    const response = await app.inject({ method: method as "GET", url, payload: payload as object,
      headers: auth ? { authorization: `Bearer ${auth}` } : {} });
    return { status: response.statusCode, body: response.json() };
  };

  beforeAll(() => {
    app = buildApp({ db, secrets, fetch: azure.fetch });
    azure.addWorkItem(1, {
      "System.Title": "Add health endpoint", "System.State": "New", "System.WorkItemType": "User Story",
      "System.Tags": "repo:api; backend", "System.Description": "<p>Expose <b>GET /health</b></p>",
    });
    azure.addWorkItem(2, { "System.Title": "Old bug", "System.State": "Closed", "System.WorkItemType": "Bug",
      "System.AssignedTo": { displayName: "Joe Smith", uniqueName: "joe@acme.com" } });
  });

  it("sets up the first tenant once", async () => {
    const setup = await call("POST", "/api/setup", { tenantName: "Acme", email: "Jane@Acme.com", name: "Jane" }, "");
    expect(setup.status).toBe(200);
    token = setup.body.token;
    tenantId = setup.body.tenantId;
    expect((await call("POST", "/api/setup", { tenantName: "X", email: "x@x.com", name: "X" }, "")).status).toBe(409);
    expect((await call("GET", "/api/me", undefined, "")).status).toBe(401);
  });

  it("connects to Azure and mirrors teams, repos, commits and work items", async () => {
    expect((await call("PUT", `/api/t/${tenantId}/connection`, { organizationUrl: ORG, project: "Shop", pat: PAT,
      webhookSecret: "hook-secret-1234567890", reviewState: "Resolved" })).status).toBe(200);
    const test = await call("POST", `/api/t/${tenantId}/connection/test`);
    expect(test.body.ok).toBe(true);
    const sync = await call("POST", `/api/t/${tenantId}/sync`);
    expect(sync.body.result).toMatchObject({ teams: 1, repositories: 1, workItems: 2, commits: 1, queuedRuns: 0 });
    const teams = await call("GET", `/api/t/${tenantId}/teams`);
    expect(teams.body[0].members.map((m: { uniqueName: string }) => m.uniqueName)).toEqual(["jane@acme.com", "joe@acme.com"]);
    const detail = await call("GET", `/api/t/${tenantId}/work-items/1`);
    expect(detail.body.item.repoNames).toEqual(["api"]);
    expect(detail.body.commits[0].commitId).toBe("c0ffee");
  });

  it("provisions one agent per team member and assigns skills and MCP servers", async () => {
    const teams = await call("GET", `/api/t/${tenantId}/teams`);
    const provision = await call("POST", `/api/t/${tenantId}/teams/${teams.body[0].id}/provision-agents`, { provider: "claude" });
    expect(provision.body.created).toBe(2);
    expect((await call("POST", `/api/t/${tenantId}/teams/${teams.body[0].id}/provision-agents`, {})).body.created).toBe(0);

    const suggestions = await call("GET", `/api/t/${tenantId}/skills/suggestions`);
    expect(suggestions.body.map((s: { key: string }) => s.key)).toContain("node-typescript");
    expect((await call("PUT", `/api/t/${tenantId}/skills/node-typescript`, { name: "Node", content: "Use pnpm." })).status).toBe(200);
    expect((await call("PUT", `/api/t/${tenantId}/mcp-servers/playwright`, { transport: "stdio", command: "npx", args: ["@playwright/mcp"] })).status).toBe(200);
    const agents = await call("GET", `/api/t/${tenantId}/agents`);
    const jane = agents.body.find((a: { pairedUniqueName: string }) => a.pairedUniqueName === "jane@acme.com");
    await call("PUT", `/api/t/${tenantId}/agents/${jane.id}/skills`, { skillKeys: ["node-typescript"] });
    await call("PUT", `/api/t/${tenantId}/agents/${jane.id}/mcp-servers`, { names: ["playwright"] });
    expect((await call("GET", `/api/t/${tenantId}/agents`)).body.find((a: { id: string }) => a.id === jane.id))
      .toMatchObject({ skills: ["node-typescript"], mcpServers: ["playwright"] });
  });

  it("queues work when a developer assigns an item to themselves, and the agent opens a PR", async () => {
    const assign = await call("POST", `/api/t/${tenantId}/work-items/1/assign`, { to: "me" });
    expect(assign.body.queuedRuns).toBe(1);
    expect(azure.workItems.get(1)!.fields["System.AssignedTo"]).toMatchObject({ uniqueName: "Jane@Acme.com" });

    const seen: string[][] = [];
    const exec: Exec = async (command, args, options) => {
      if (command === "claude") {
        seen.push(args);
        expect(await fs.readFile(path.join(options.cwd, ".claude/skills/node-typescript/SKILL.md"), "utf8")).toContain("Use pnpm.");
        expect(JSON.parse(await fs.readFile(path.join(options.cwd, ".mcp.json"), "utf8")).mcpServers.playwright.command).toBe("npx");
        await fs.writeFile(path.join(options.cwd, "api", "health.ts"), "export const health = () => 'ok';\n");
        return { code: 0, stdout: "Added health endpoint.", stderr: "", timedOut: false };
      }
      return spawnExec(command, args, options);
    };
    const processed = await runQueuedOnce({ db, secrets, workspaceRoot: path.join(tmp, "ws"), timeoutMs: 60_000, exec, fetch: azure.fetch }, 2);
    expect(processed).toBe(1);
    expect(seen[0]!.join(" ")).toContain("Add health endpoint");

    const runs = await call("GET", `/api/t/${tenantId}/runs`);
    expect(runs.body[0]).toMatchObject({ status: "succeeded", branch: "ab/1-add-health-endpoint", azureId: 1 });
    expect(runs.body[0].pullRequestUrls[0]).toBe(`${ORG}/Shop/_git/api/pullrequest/1`);
    expect(azure.pullRequests[0]).toMatchObject({ sourceRefName: "refs/heads/ab/1-add-health-endpoint", targetRefName: "refs/heads/main", workItemIds: [1] });
    expect(git(path.join(tmp, "api.git"), "log", "--oneline", "ab/1-add-health-endpoint")).toContain("AB#1: Add health endpoint");
    expect(azure.comments[0]!.text).toContain("pullrequest/1");
    expect(azure.workItems.get(1)!.fields["System.State"]).toBe("Resolved");
    expect((await call("GET", `/api/t/${tenantId}/runs/${runs.body[0].id}`)).body.log).not.toContain(PAT);

    // The same item is not queued again, and the new PR is mirrored on the next sync.
    const sync = await call("POST", `/api/t/${tenantId}/sync`);
    expect(sync.body.result.queuedRuns).toBe(0);
    expect((await call("GET", `/api/t/${tenantId}/work-items/1`)).body.pullRequests[0]).toMatchObject({ azurePrId: 1, status: "active" });
  });

  it("fails clearly when the item names no known repository, and allows a retry", async () => {
    azure.addWorkItem(3, { "System.Title": "No repo", "System.State": "Active", "System.WorkItemType": "Task",
      "System.AssignedTo": { displayName: "Joe Smith", uniqueName: "joe@acme.com" } });
    await call("POST", `/api/t/${tenantId}/sync`);
    await runQueuedOnce({ db, secrets, workspaceRoot: path.join(tmp, "ws"), timeoutMs: 60_000, fetch: azure.fetch }, 2);
    const run = (await call("GET", `/api/t/${tenantId}/runs`)).body.find((r: { azureId: number }) => r.azureId === 3);
    expect(run).toMatchObject({ status: "failed" });
    expect(run.error).toMatch(/repo:<name>/);
    expect((await call("POST", `/api/t/${tenantId}/runs/${run.id}/retry`)).status).toBe(200);
    expect((await call("POST", `/api/t/${tenantId}/runs/${run.id}/retry`)).status).toBe(409);
  });

  it("verifies Service Hook credentials and syncs the changed item", async () => {
    const hook = (password: string) => app.inject({ method: "POST", url: `/api/hooks/${tenantId}`,
      headers: { authorization: `Basic ${Buffer.from(`azure:${password}`).toString("base64")}` },
      payload: { eventType: "workitem.updated", resource: { workItemId: 2 } } });
    expect((await hook("wrong")).statusCode).toBe(401);
    azure.workItems.get(2)!.fields["System.Title"] = "Old bug (renamed)";
    azure.workItems.get(2)!.rev += 1;
    expect((await hook("hook-secret-1234567890")).statusCode).toBe(200);
    expect((await call("GET", `/api/t/${tenantId}/work-items/2`)).body.item.title).toBe("Old bug (renamed)");
  });

  it("isolates tenants with row-level security and membership checks", async () => {
    const other = await call("POST", "/api/tenants", { name: "Globex" });
    const otherId = other.body.tenantId;
    expect((await withTenant(db, otherId, (tx) => tx.query("SELECT count(*)::int AS n FROM work_items"))).rows[0].n).toBe(0);
    expect((await withTenant(db, tenantId, (tx) => tx.query("SELECT count(*)::int AS n FROM work_items"))).rows[0].n).toBe(3);
    // Without a tenant setting, RLS hides every row.
    expect((await db.query("SELECT count(*)::int AS n FROM work_items")).rows[0].n).toBe(0);
    await expect(withTenant(db, otherId, (tx) =>
      tx.query("INSERT INTO skills (tenant_id, key, name, content) VALUES ($1, 'x', 'x', 'x')", [tenantId]))).rejects.toThrow(/row-level security/);

    const invite = await call("POST", `/api/t/${tenantId}/members`, { email: "dev@acme.com", name: "Dev", role: "member" });
    const devToken = invite.body.token;
    expect((await call("GET", `/api/t/${tenantId}/work-items`, undefined, devToken)).status).toBe(200);
    expect((await call("GET", `/api/t/${otherId}/work-items`, undefined, devToken)).status).toBe(403);
    expect((await call("POST", `/api/t/${tenantId}/agents`, { name: "x", provider: "openai" }, devToken)).status).toBe(403);
  });
});
