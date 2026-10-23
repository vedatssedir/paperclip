import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest, { ISSUE_ORIGIN_KIND } from "../src/manifest.js";
import plugin from "../src/worker.js";

/**
 * End-to-end scenario against an in-memory fake of the Azure DevOps REST API:
 * connection test → team developer agents → board sync → status push-back → close.
 */

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ORG = "https://dev.azure.com/acme";

interface FakeWorkItem {
  id: number;
  rev: number;
  url: string;
  fields: Record<string, unknown>;
}

function createFakeAzure() {
  const workItems = new Map<number, FakeWorkItem>([
    [1, {
      id: 1, rev: 1, url: "", fields: {
        "System.Title": "Login fails on Safari",
        "System.State": "New",
        "System.WorkItemType": "Bug",
        "System.Tags": "repo:api; repo:legacy",
        "System.Description": "<p>Users cannot log in.</p>",
        "System.AssignedTo": { displayName: "Jane Doe", uniqueName: "jane@acme.com" },
        "Microsoft.VSTS.Common.Priority": 1,
      },
    }],
    [2, {
      id: 2, rev: 1, url: "", fields: {
        "System.Title": "Add dark mode",
        "System.State": "New",
        "System.WorkItemType": "User Story",
        "System.Tags": "repo:web",
      },
    }],
  ]);
  const requests: Array<{ method: string; url: string; body: unknown }> = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body });
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    if (!auth.startsWith("Basic ")) return json({ message: "unauthorized" }, 401);

    if (method === "POST" && url.includes("/_apis/wit/wiql")) {
      return json({ workItems: [...workItems.keys()].map((id) => ({ id })) });
    }
    if (method === "POST" && url.includes("/_apis/wit/workitemsbatch")) {
      const ids = (body as { ids: number[] }).ids;
      return json({ value: ids.map((id) => workItems.get(id)).filter(Boolean) });
    }
    const patch = url.match(/\/_apis\/wit\/workitems\/(\d+)\?/);
    if (method === "PATCH" && patch) {
      const item = workItems.get(Number(patch[1]))!;
      for (const op of body as Array<{ path: string; value: unknown }>) {
        item.fields[op.path.replace("/fields/", "")] = op.value;
      }
      item.rev += 1;
      return json(item);
    }
    if (method === "POST" && /\/_apis\/wit\/workItems\/\d+\/comments/.test(url)) return json({ id: 1 });
    if (method === "GET" && /\/_apis\/projects\/[^/]+\/teams\/[^/]+\/members/.test(url)) {
      return json({ value: [
        { identity: { id: "u1", displayName: "Jane Doe", uniqueName: "jane@acme.com" } },
        { identity: { id: "u2", displayName: "Joe Smith", uniqueName: "joe@acme.com" } },
      ] });
    }
    if (method === "GET" && /\/_apis\/projects\/[^/]+\/teams/.test(url)) return json({ value: [{ id: "t1", name: "Backend" }] });
    if (method === "GET" && /\/_apis\/git\/repositories/.test(url)) {
      return json({ value: [{ id: "r1", name: "api", defaultBranch: "refs/heads/main", webUrl: `${ORG}/Shop/_git/api` }] });
    }
    if (method === "GET" && /\/_apis\/projects\/[^/?]+/.test(url)) return json({ id: "p1", name: "Shop" });
    return json({ message: `no fake route for ${method} ${url}` }, 404);
  });

  return { fetch, workItems, requests };
}

describe("Azure DevOps plugin scenario (fake Azure)", () => {
  let azure: ReturnType<typeof createFakeAzure>;

  beforeEach(() => {
    azure = createFakeAzure();
    vi.stubGlobal("fetch", azure.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setup() {
    const harness = createTestHarness({
      manifest,
      config: {
        organizationUrl: ORG,
        project: "Shop",
        personalAccessToken: { type: "secret_ref", secretId: "pat" },
        teams: ["Backend"],
        allowedRepositories: ["api", "web"],
        defaultAgentSkills: ["paperclip"],
        agentMonthlyBudgetCents: 5000,
      },
    });
    harness.seed({ companies: [{ id: COMPANY_ID, name: "Acme" } as Company] });
    await plugin.definition.setup(harness.ctx);
    return harness;
  }

  it("connects, provisions agents, syncs the board and writes status back", async () => {
    const harness = await setup();

    const connection = await harness.performAction<{ ok: boolean; teams: unknown[]; repositories: Array<{ name: string }> }>(
      "test-connection", {}, { companyId: COMPANY_ID },
    );
    expect(connection.ok).toBe(true);
    expect(connection.repositories.map((repo) => repo.name)).toEqual(["api"]);

    // One developer agent per Azure team member, with default skills and budget.
    const agentSync = await harness.performAction<{ agents: Array<{ uniqueName: string; agentId: string }> }>(
      "sync-agents", {}, { companyId: COMPANY_ID },
    );
    expect(agentSync.agents.map((agent) => agent.uniqueName).sort()).toEqual(["jane@acme.com", "joe@acme.com"]);
    const agents = await harness.ctx.agents.list({ companyId: COMPANY_ID });
    const jane = agents.find((agent) => agent.name === "Jane Doe")!;
    expect(jane.role).toBe("engineer");
    expect(jane.budgetMonthlyCents).toBe(5000);
    expect(jane.adapterConfig).toMatchObject({ paperclipSkillSync: { desiredSkills: ["paperclip"] } });
    // Re-running is idempotent.
    await harness.performAction("sync-agents", {}, { companyId: COMPANY_ID });
    expect(await harness.ctx.agents.list({ companyId: COMPANY_ID })).toHaveLength(2);

    // Board sync: assigned bug goes to Jane's agent; unassigned story waits in triage.
    const sync = await harness.performAction<{ created: number; error: string | null }>("sync-now", {}, { companyId: COMPANY_ID });
    expect(sync.error).toBeNull();
    expect(sync.created).toBe(2);
    const issues = await harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: ISSUE_ORIGIN_KIND });
    const bug = issues.find((issue) => issue.originId === "1")!;
    const story = issues.find((issue) => issue.originId === "2")!;
    expect(bug.title).toBe("[AB#1] Login fails on Safari");
    expect(bug.priority).toBe("critical");
    expect(bug.assigneeAgentId).toBe(jane.id);
    expect(bug.status).toBe("todo");
    expect(bug.description).toContain(`${ORG}/Shop/_git/api`);
    expect(bug.description).not.toContain("_git/legacy");
    expect(story.status).toBe("backlog");
    expect(story.assigneeAgentId).toBeFalsy();

    // Paperclip → Azure: in_progress moves the work item to Active.
    await harness.ctx.issues.update(bug.id, { status: "in_progress" }, COMPANY_ID);
    await harness.emit("issue.updated", {}, { companyId: COMPANY_ID, entityId: bug.id, entityType: "issue" });
    expect(azure.workItems.get(1)!.fields["System.State"]).toBe("Active");

    // Azure → Paperclip: closing the work item finishes the task on the next sync.
    azure.workItems.get(1)!.fields["System.State"] = "Closed";
    await harness.performAction("sync-now", {}, { companyId: COMPANY_ID });
    expect((await harness.ctx.issues.get(bug.id, COMPANY_ID))!.status).toBe("done");
    expect((await harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: ISSUE_ORIGIN_KIND }))).toHaveLength(2);
  });

  it("pauses and resumes every developer agent", async () => {
    const harness = await setup();
    await harness.performAction("sync-agents", {}, { companyId: COMPANY_ID });
    await harness.performAction("pause-all-agents", {}, { companyId: COMPANY_ID });
    expect((await harness.ctx.agents.list({ companyId: COMPANY_ID })).every((agent) => agent.status === "paused")).toBe(true);
    await harness.performAction("resume-all-agents", {}, { companyId: COMPANY_ID });
    expect((await harness.ctx.agents.list({ companyId: COMPANY_ID })).every((agent) => agent.status !== "paused")).toBe(true);
  });

  it("reports a rejected token without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const harness = await setup();
    const connection = await harness.performAction<{ ok: boolean }>("test-connection", {}, { companyId: COMPANY_ID });
    expect(connection.ok).toBe(false);
    const sync = await harness.performAction<{ error: string | null }>("sync-now", {}, { companyId: COMPANY_ID });
    expect(sync.error).toMatch(/HTTP 401/);
  });
});
