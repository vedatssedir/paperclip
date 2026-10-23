import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createAzureReposClient, testAzureConnection } from "../src/azure-repos.js";
import { checkPullRequestStatuses, createPullRequestForIssue } from "../src/pull-requests.js";
import { ISSUE_ORIGIN_KIND } from "../src/manifest.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function fakeFetch(routes: Array<[RegExp, number, unknown]>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const route = routes.find(([pattern]) => pattern.test(`${init?.method ?? "GET"} ${url}`));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route[2]), { status: route[1], headers: { "Content-Type": "application/json" } });
  };
  return { fetch, calls };
}

const connection = { organizationUrl: "https://dev.azure.com/acme/", project: "Fabrikam App", pat: "secret-pat" };

function fakeCtx(issue: Record<string, unknown>) {
  const state = new Map<string, unknown>();
  const comments: string[] = [];
  const updates: unknown[] = [];
  const key = (input: { scopeId?: string; namespace?: string; stateKey: string }) =>
    `${input.scopeId}:${input.namespace ?? ""}:${input.stateKey}`;
  const ctx = {
    issues: {
      get: async () => issue,
      update: async (_id: string, patch: unknown) => {
        updates.push(patch);
        return { ...issue, ...(patch as object) };
      },
      createComment: async (_id: string, body: string) => {
        comments.push(body);
        return {};
      },
    },
    state: {
      get: async (input: never) => state.get(key(input)) ?? null,
      set: async (input: never, value: unknown) => void state.set(key(input), value),
      delete: async (input: never) => void state.delete(key(input)),
    },
    activity: { log: async () => undefined },
    logger: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
  return { ctx, state, comments, updates };
}

describe("azure repos client", () => {
  it("creates a pull request with branch refs and work item links", async () => {
    const { fetch, calls } = fakeFetch([[/POST .*pullrequests/, 201, { pullRequestId: 7, status: "active" }]]);
    const client = createAzureReposClient({ ...connection, fetch });
    await client.createPullRequest("repo-1", "task/PAP-1", "main", "PAP-1: Fix", "Body", 42);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://dev.azure.com/acme/Fabrikam%20App/_apis/git/repositories/repo-1/pullrequests?api-version=7.1",
    );
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from(":secret-pat").toString("base64")}`);
    expect(calls[0]!.body).toEqual({
      sourceRefName: "refs/heads/task/PAP-1",
      targetRefName: "refs/heads/main",
      title: "PAP-1: Fix",
      description: "Body",
      workItemRefs: [{ id: "42" }],
    });
  });

  it("gets a pull request by id", async () => {
    const { fetch, calls } = fakeFetch([[/GET .*pullrequests\/7/, 200, { pullRequestId: 7, status: "completed" }]]);
    const pr = await createAzureReposClient({ ...connection, fetch }).getPullRequest("repo-1", 7);
    expect(pr.status).toBe("completed");
    expect(calls[0]!.url).toContain("/_apis/git/repositories/repo-1/pullrequests/7?api-version=7.1");
  });
});

describe("pull request tool flow", () => {
  const issue = {
    id: "issue-1",
    identifier: "PAP-1",
    title: "Fix login",
    status: "in_progress",
    originKind: ISSUE_ORIGIN_KIND,
    originId: "42",
  };
  const repoRoute: [RegExp, number, unknown] = [
    /GET .*repositories\/web\?/,
    200,
    { id: "repo-1", name: "web", defaultBranch: "refs/heads/main" },
  ];

  it("opens a PR against the default branch, links the work item, comments and tracks it", async () => {
    const { fetch, calls } = fakeFetch([repoRoute, [/POST .*pullrequests/, 201, { pullRequestId: 7, status: "active" }]]);
    const { ctx, comments, state } = fakeCtx(issue);
    const tracked = await createPullRequestForIssue(
      ctx,
      "company-1",
      { issueId: "issue-1", repository: "web", sourceBranch: "task/PAP-1" },
      createAzureReposClient({ ...connection, fetch }),
    );

    expect(calls[1]!.body).toMatchObject({
      targetRefName: "refs/heads/main",
      title: "PAP-1: Fix login",
      workItemRefs: [{ id: "42" }],
    });
    expect(tracked.url).toBe("https://dev.azure.com/acme/Fabrikam%20App/_git/web/pullrequest/7");
    expect(comments[0]).toContain(tracked.url);
    expect(state.get("company-1::pull-request-index")).toEqual(["issue-1"]);
  });

  it("refuses to open a PR from the default branch", async () => {
    const { fetch, calls } = fakeFetch([repoRoute]);
    const { ctx } = fakeCtx(issue);
    await expect(
      createPullRequestForIssue(
        ctx,
        "company-1",
        { issueId: "issue-1", repository: "web", sourceBranch: "main" },
        createAzureReposClient({ ...connection, fetch }),
      ),
    ).rejects.toThrow(/feature branch/);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("marks the issue done when its PR is completed", async () => {
    const { fetch } = fakeFetch([
      repoRoute,
      [/POST .*pullrequests/, 201, { pullRequestId: 7, status: "active" }],
      [/GET .*pullrequests\/7/, 200, { pullRequestId: 7, status: "completed" }],
    ]);
    const client = createAzureReposClient({ ...connection, fetch });
    const { ctx, updates, state } = fakeCtx(issue);
    await createPullRequestForIssue(ctx, "company-1", { issueId: "issue-1", repository: "web", sourceBranch: "task/PAP-1" }, client);

    const result = await checkPullRequestStatuses(ctx, "company-1", client);
    expect(result).toEqual({ checked: 1, completed: 1 });
    expect(updates).toEqual([{ status: "done" }]);
    expect(state.get("company-1::pull-request-index")).toEqual([]);
  });
});

describe("test connection", () => {
  it("reports project, teams and repositories", async () => {
    const { fetch, calls } = fakeFetch([
      [/GET .*\/_apis\/projects\/Fabrikam%20App\?/, 200, { id: "p1", name: "Fabrikam App" }],
      [/GET .*\/teams/, 200, { value: [{ id: "t1", name: "Core" }] }],
      [/GET .*\/_apis\/git\/repositories\?/, 200, { value: [{ id: "r1", name: "web", defaultBranch: "refs/heads/main" }] }],
    ]);
    const result = await testAzureConnection({ ...connection, fetch });
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
      ["pat", true],
      ["project", true],
      ["teams", true],
      ["repositories", true],
    ]);
    expect(result.teams).toEqual([{ id: "t1", name: "Core" }]);
    expect(result.repositories).toEqual([{ id: "r1", name: "web", defaultBranch: "refs/heads/main" }]);
    expect(calls.some((call) => call.url === "https://dev.azure.com/acme/Fabrikam%20App/_apis/git/repositories?api-version=7.1")).toBe(true);
  });

  it("reports an invalid PAT and stops", async () => {
    const { fetch, calls } = fakeFetch([[/projects/, 401, {}]]);
    const result = await testAzureConnection({ ...connection, fetch });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([{ name: "pat", ok: false, detail: expect.stringContaining("rejected") }]);
    expect(calls).toHaveLength(1);
  });

  it("reports a missing project", async () => {
    const { fetch } = fakeFetch([]);
    const result = await testAzureConnection({ ...connection, fetch });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      { name: "pat", ok: true, detail: expect.any(String) },
      { name: "project", ok: false, detail: expect.stringContaining("not found") },
    ]);
  });
});
