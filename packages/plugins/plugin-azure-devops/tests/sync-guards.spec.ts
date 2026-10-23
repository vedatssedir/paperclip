import { describe, expect, it } from "vitest";
import { createAzureClient } from "../src/azure-client.js";
import { DEFAULT_WORK_ITEM_QUERY, issueDescription, parseSettings } from "../src/mapping.js";
import {
  buildSyncQuery,
  fetchWithRetry,
  initialTaskPlacement,
  parseServiceHook,
  retryDelayMs,
  verifyWebhookSecret,
} from "../src/sync-guards.js";

function response(status: number, headers: Record<string, string> = {}, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("retry", () => {
  it("honors Retry-After seconds and dates, else backs off exponentially", () => {
    expect(retryDelayMs("2", 1)).toBe(2000);
    expect(retryDelayMs(new Date(10_000).toUTCString(), 1, 7_000)).toBe(3000);
    expect(retryDelayMs(null, 1)).toBe(500);
    expect(retryDelayMs(null, 3)).toBe(2000);
    expect(retryDelayMs("9999", 1)).toBe(30_000);
  });

  it("retries 429/503 at most three times", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    let calls = 0;
    const ok = await fetchWithRetry(async () => (++calls < 3 ? response(429, { "Retry-After": "1" }) : response(200)), sleep);
    expect(ok.status).toBe(200);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 1000]);

    calls = 0;
    const failed = await fetchWithRetry(async () => (++calls, response(503)), sleep);
    expect(failed.status).toBe(503);
    expect(calls).toBe(3);

    calls = 0;
    await fetchWithRetry(async () => (++calls, response(500)), sleep);
    expect(calls).toBe(1);
  });

  it("client retries throttled requests and caps WIQL results", async () => {
    const urls: string[] = [];
    let calls = 0;
    const client = createAzureClient({
      organizationUrl: "https://dev.azure.com/acme",
      project: "Shop",
      pat: "pat",
      sleep: async () => {},
      fetch: async (url) => {
        urls.push(url);
        return ++calls === 1 ? response(429) : response(200, {}, { workItems: [{ id: 1 }, { id: 2 }] });
      },
    });
    await expect(client.queryWorkItemIds("SELECT", undefined, 501)).resolves.toEqual([1, 2]);
    expect(calls).toBe(2);
    expect(urls[1]).toContain("$top=501");
  });
});

describe("incremental query", () => {
  it("adds a ChangedDate filter to the default query after a successful sync", () => {
    expect(buildSyncQuery(DEFAULT_WORK_ITEM_QUERY, null)).toBe(DEFAULT_WORK_ITEM_QUERY);
    const query = buildSyncQuery(DEFAULT_WORK_ITEM_QUERY, "2026-10-22T23:59:00Z");
    expect(query).toContain("@today - 30 AND [System.ChangedDate] >= '2026-10-22' ORDER BY");
    expect(buildSyncQuery("SELECT [System.Id] FROM WorkItems", "2026-10-22T00:00:00Z")).toBe("SELECT [System.Id] FROM WorkItems");
    expect(buildSyncQuery(DEFAULT_WORK_ITEM_QUERY, "garbage")).toBe(DEFAULT_WORK_ITEM_QUERY);
  });
});

describe("webhook auth", () => {
  it("accepts the secret as basic auth password or header", () => {
    const basic = `Basic ${Buffer.from("azure:s3cret").toString("base64")}`;
    expect(verifyWebhookSecret({ Authorization: basic }, "s3cret")).toBe(true);
    expect(verifyWebhookSecret({ "x-paperclip-webhook-secret": "s3cret" }, "s3cret")).toBe(true);
    expect(verifyWebhookSecret({ "X-Paperclip-Webhook-Secret": ["s3cret"] }, "s3cret")).toBe(true);
    expect(verifyWebhookSecret({ "x-paperclip-webhook-secret": "wrong" }, "s3cret")).toBe(false);
    expect(verifyWebhookSecret({ Authorization: `Basic ${Buffer.from("azure:s3").toString("base64")}` }, "s3cret")).toBe(false);
    expect(verifyWebhookSecret({}, "s3cret")).toBe(false);
    expect(verifyWebhookSecret({ "x-paperclip-webhook-secret": "" }, "")).toBe(false);
  });

  it("parses work item service hooks", () => {
    expect(parseServiceHook({ eventType: "workitem.created", resource: { id: 5, fields: { "System.TeamProject": "Shop" } } }))
      .toEqual({ workItemId: 5, project: "Shop" });
    expect(parseServiceHook({ eventType: "workitem.updated", resource: { id: 99, workItemId: 7, revision: { fields: {} } } }))
      .toEqual({ workItemId: 7, project: null });
    expect(parseServiceHook({ eventType: "git.push", resource: { id: 1 } })).toBeNull();
    expect(parseServiceHook(null)).toBeNull();
  });
});

describe("guardrails", () => {
  it("parses guardrail settings with defaults", () => {
    const settings = parseSettings({ organizationUrl: "https://dev.azure.com/acme", project: "Shop", personalAccessToken: "ref" });
    expect(settings).toMatchObject({
      maxWorkItemsPerSync: 500,
      maxNewTasksPerSync: 25,
      agentMonthlyBudgetCents: null,
      requireTriage: true,
      allowedRepositories: [],
    });
    expect(parseSettings({
      organizationUrl: "x", project: "y", personalAccessToken: "ref", agentMonthlyBudgetCents: 1500, requireTriage: false,
    })).toMatchObject({ agentMonthlyBudgetCents: 1500, requireTriage: false });
  });

  it("drops repositories outside the allowlist and notes them", () => {
    const description = issueDescription(
      { id: 7, rev: 1, url: "", fields: { "System.Tags": "repo:api; repo:secret-infra" } },
      { webUrl: "u", organizationUrl: "https://dev.azure.com/acme", project: "Shop", allowedRepositories: ["API"] },
    );
    expect(description).toContain("- api:");
    expect(description).not.toContain("- secret-infra:");
    expect(description).toContain("not allowed by plugin settings (ignored): secret-infra");
  });

  it("places new tasks in backlog unassigned when triage is required", () => {
    expect(initialTaskPlacement({ azureStatus: "todo", assigneeAgentId: undefined, requireTriage: true }))
      .toEqual({ status: "backlog", assigneeAgentId: undefined });
    expect(initialTaskPlacement({ azureStatus: "in_progress", assigneeAgentId: "a1", requireTriage: true }))
      .toEqual({ status: "todo", assigneeAgentId: "a1" });
    expect(initialTaskPlacement({ azureStatus: "todo", assigneeAgentId: undefined, requireTriage: false }))
      .toEqual({ status: "todo", assigneeAgentId: undefined });
    expect(initialTaskPlacement({ azureStatus: "done", assigneeAgentId: undefined, requireTriage: true }).status).toBe("done");
  });
});
