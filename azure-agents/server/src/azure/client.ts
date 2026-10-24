/**
 * Azure DevOps REST client (api-version 7.1). Authenticates with a PAT over HTTP Basic.
 * Retries 429/503 honoring Retry-After; error messages carry status only, never bodies.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface AzureWorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
}

export interface AzureIdentityRef {
  displayName: string;
  uniqueName: string;
}

export interface AzureRepository {
  id: string;
  name: string;
  defaultBranch?: string;
  remoteUrl: string;
  webUrl: string;
}

export interface AzureCommit {
  commitId: string;
  author: { name: string; email?: string; date: string };
  comment: string;
  remoteUrl: string;
}

export interface AzurePullRequest {
  pullRequestId: number;
  title: string;
  status: "active" | "abandoned" | "completed";
  sourceRefName: string;
  targetRefName: string;
  createdBy: AzureIdentityRef;
  creationDate: string;
  closedDate?: string;
  repository: { id: string; name: string; webUrl?: string };
}

export class AzureHttpError extends Error {
  constructor(readonly status: number, method: string, path: string) {
    super(`Azure DevOps ${method} ${path} failed with HTTP ${status}`);
  }
}

export const WORK_ITEM_FIELDS = [
  "System.Title", "System.State", "System.WorkItemType", "System.AssignedTo", "System.Tags",
  "System.AreaPath", "System.IterationPath", "System.Description", "System.ChangedDate",
  "Microsoft.VSTS.Common.Priority",
];

const MAX_ATTEMPTS = 3;

export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }
  return Math.min(500 * 2 ** attempt, 30_000);
}

export function createAzureClient(options: {
  organizationUrl: string;
  project: string;
  pat: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}) {
  const base = options.organizationUrl.replace(/\/+$/, "");
  const project = encodeURIComponent(options.project);
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const authorization = `Basic ${Buffer.from(`:${options.pat}`).toString("base64")}`;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { contentType?: string; apiVersion?: string } = {},
  ): Promise<T> {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${base}${path}${separator}api-version=${opts.apiVersion ?? "7.1"}`;
    for (let attempt = 0; ; attempt += 1) {
      const response = await doFetch(url, {
        method,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": opts.contentType ?? "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if ((response.status === 429 || response.status === 503) && attempt + 1 < MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt, response.headers.get("Retry-After")));
        continue;
      }
      // 203 is Azure's sign-in page for a rejected PAT.
      if (!response.ok || response.status === 203) throw new AzureHttpError(response.status, method, path.split("?")[0]!);
      return (await response.json()) as T;
    }
  }

  const repoPath = (repo: string) => `/${project}/_apis/git/repositories/${encodeURIComponent(repo)}`;

  return {
    async getProject(): Promise<{ id: string; name: string }> {
      return request("GET", `/_apis/projects/${project}`);
    },

    async queryWorkItemIds(wiql: string): Promise<number[]> {
      const result = await request<{ workItems?: Array<{ id: number }> }>("POST", `/${project}/_apis/wit/wiql`, { query: wiql });
      return (result.workItems ?? []).map((item) => item.id);
    },

    async getWorkItems(ids: number[]): Promise<AzureWorkItem[]> {
      const items: AzureWorkItem[] = [];
      for (let index = 0; index < ids.length; index += 200) {
        const result = await request<{ value: AzureWorkItem[] }>("POST", `/${project}/_apis/wit/workitemsbatch`, {
          ids: ids.slice(index, index + 200),
          fields: WORK_ITEM_FIELDS,
        });
        items.push(...result.value);
      }
      return items;
    },

    async updateWorkItemFields(id: number, fields: Record<string, unknown>): Promise<AzureWorkItem> {
      return request("PATCH", `/${project}/_apis/wit/workitems/${id}`,
        Object.entries(fields).map(([field, value]) => ({ op: "add", path: `/fields/${field}`, value })),
        { contentType: "application/json-patch+json" });
    },

    async addWorkItemComment(id: number, text: string): Promise<void> {
      await request("POST", `/${project}/_apis/wit/workItems/${id}/comments`, { text }, { apiVersion: "7.1-preview.4" });
    },

    async listTeams(): Promise<Array<{ id: string; name: string }>> {
      return (await request<{ value: Array<{ id: string; name: string }> }>("GET", `/_apis/projects/${project}/teams?$top=500`)).value;
    },

    async listTeamMembers(teamId: string): Promise<AzureIdentityRef[]> {
      const result = await request<{ value: Array<{ identity: AzureIdentityRef }> }>(
        "GET", `/_apis/projects/${project}/teams/${encodeURIComponent(teamId)}/members?$top=500`);
      return result.value.map((member) => member.identity);
    },

    async listRepositories(): Promise<AzureRepository[]> {
      return (await request<{ value: AzureRepository[] }>("GET", `/${project}/_apis/git/repositories`)).value;
    },

    async listCommits(repo: string, since?: Date): Promise<AzureCommit[]> {
      const fromDate = since ? `&searchCriteria.fromDate=${encodeURIComponent(since.toISOString())}` : "";
      return (await request<{ value: AzureCommit[] }>("GET", `${repoPath(repo)}/commits?searchCriteria.$top=200${fromDate}`)).value;
    },

    async listRootFiles(repo: string): Promise<string[]> {
      const result = await request<{ value: Array<{ path: string; isFolder?: boolean }> }>(
        "GET", `${repoPath(repo)}/items?scopePath=%2F&recursionLevel=OneLevel`);
      return result.value.filter((item) => !item.isFolder).map((item) => item.path.replace(/^\//, ""));
    },

    async listPullRequests(repo: string): Promise<AzurePullRequest[]> {
      return (await request<{ value: AzurePullRequest[] }>("GET", `${repoPath(repo)}/pullrequests?searchCriteria.status=all&$top=200`)).value;
    },

    async getPullRequestWorkItemIds(repo: string, pullRequestId: number): Promise<number[]> {
      const result = await request<{ value: Array<{ id: string }> }>("GET", `${repoPath(repo)}/pullRequests/${pullRequestId}/workitems`);
      return result.value.map((ref) => Number(ref.id)).filter(Number.isFinite);
    },

    async createPullRequest(input: {
      repo: string;
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description: string;
      workItemId: number;
    }): Promise<AzurePullRequest> {
      const ref = (branch: string) => (branch.startsWith("refs/") ? branch : `refs/heads/${branch}`);
      return request("POST", `${repoPath(input.repo)}/pullrequests`, {
        sourceRefName: ref(input.sourceBranch),
        targetRefName: ref(input.targetBranch),
        title: input.title,
        description: input.description,
        workItemRefs: [{ id: String(input.workItemId) }],
      });
    },

    pullRequestWebUrl(repoWebUrl: string, pullRequestId: number) {
      return `${repoWebUrl}/pullrequest/${pullRequestId}`;
    },

    workItemWebUrl(id: number) {
      return `${base}/${project}/_workitems/edit/${id}`;
    },
  };
}

export type AzureClient = ReturnType<typeof createAzureClient>;
