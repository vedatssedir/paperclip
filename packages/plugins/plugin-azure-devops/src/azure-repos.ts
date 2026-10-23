/**
 * Azure Repos and connection-check REST calls. Kept separate from
 * azure-client.ts (board sync) so the two can evolve independently.
 */

import { AZURE_API_VERSION, createAzureClient, type AzureTeam } from "./azure-client.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface AzureConnectionOptions {
  organizationUrl: string;
  project: string;
  pat: string;
  fetch: Fetch;
}

export interface AzureRepository {
  id: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
  remoteUrl?: string;
}

export interface AzurePullRequest {
  pullRequestId: number;
  status: "active" | "abandoned" | "completed" | "notSet" | string;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus?: string;
  repository: { id: string; name: string; webUrl?: string };
  url: string;
}

export class AzureHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    // Provider error bodies can echo request details; report status only.
    super(`Azure DevOps request failed: ${method} ${path} → HTTP ${status}`);
  }
}

export function toBranchRef(branch: string) {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function createAzureReposClient(options: AzureConnectionOptions) {
  const base = options.organizationUrl.replace(/\/+$/, "");
  const project = encodeURIComponent(options.project);
  const authorization = `Basic ${Buffer.from(`:${options.pat}`).toString("base64")}`;

  async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? "GET";
    const separator = path.includes("?") ? "&" : "?";
    const response = await options.fetch(`${base}${path}${separator}api-version=${AZURE_API_VERSION}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!response.ok) throw new AzureHttpError(response.status, method, path.split("?")[0] ?? path);
    return (await response.json()) as T;
  }

  const repoPath = (repo: string) => `/${project}/_apis/git/repositories/${encodeURIComponent(repo)}`;

  return {
    async getProject(): Promise<{ id: string; name: string }> {
      return request(`/_apis/projects/${project}`);
    },

    async listRepositories(): Promise<AzureRepository[]> {
      const result = await request<{ value: AzureRepository[] }>(`/${project}/_apis/git/repositories`);
      return result.value;
    },

    async getRepository(repo: string): Promise<AzureRepository> {
      return request(repoPath(repo));
    },

    async createPullRequest(
      repo: string,
      sourceBranch: string,
      targetBranch: string,
      title: string,
      description: string,
      workItemId?: number | null,
    ): Promise<AzurePullRequest> {
      return request(`${repoPath(repo)}/pullrequests`, {
        method: "POST",
        body: {
          sourceRefName: toBranchRef(sourceBranch),
          targetRefName: toBranchRef(targetBranch),
          title,
          description,
          ...(workItemId ? { workItemRefs: [{ id: String(workItemId) }] } : {}),
        },
      });
    },

    async getPullRequest(repo: string, pullRequestId: number): Promise<AzurePullRequest> {
      return request(`${repoPath(repo)}/pullrequests/${pullRequestId}`);
    },

    pullRequestWebUrl(repoName: string, pullRequestId: number) {
      return `${base}/${project}/_git/${encodeURIComponent(repoName)}/pullrequest/${pullRequestId}`;
    },
  };
}

export type AzureReposClient = ReturnType<typeof createAzureReposClient>;

export interface ConnectionCheck {
  name: "pat" | "project" | "teams" | "repositories";
  ok: boolean;
  detail: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  checks: ConnectionCheck[];
  project: { id: string; name: string } | null;
  teams: AzureTeam[];
  repositories: Array<{ id: string; name: string; defaultBranch: string | null }>;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks PAT validity, project access, and read access to teams and
 * repositories. Never throws; each step reports its own outcome.
 */
export async function testAzureConnection(options: AzureConnectionOptions): Promise<ConnectionTestResult> {
  const repos = createAzureReposClient(options);
  const boards = createAzureClient(options);
  const result: ConnectionTestResult = { ok: false, checks: [], project: null, teams: [], repositories: [] };

  try {
    const project = await repos.getProject();
    result.project = { id: project.id, name: project.name };
    result.checks.push({ name: "pat", ok: true, detail: "Personal access token accepted" });
    result.checks.push({ name: "project", ok: true, detail: `Project ${project.name} is accessible` });
  } catch (error) {
    const status = error instanceof AzureHttpError ? error.status : null;
    if (status === 401 || status === 203) {
      result.checks.push({ name: "pat", ok: false, detail: "Personal access token was rejected (expired, revoked or wrong organization)" });
    } else {
      result.checks.push({ name: "pat", ok: status !== null, detail: status !== null ? "Personal access token accepted" : describe(error) });
      result.checks.push({
        name: "project",
        ok: false,
        detail: status === 404 ? `Project ${options.project} was not found or is not visible to this token` : describe(error),
      });
    }
    return result;
  }

  try {
    result.teams = await boards.listTeams();
    result.checks.push({ name: "teams", ok: true, detail: `${result.teams.length} teams` });
  } catch (error) {
    result.checks.push({ name: "teams", ok: false, detail: describe(error) });
  }

  try {
    result.repositories = (await repos.listRepositories()).map((repo) => ({
      id: repo.id,
      name: repo.name,
      defaultBranch: repo.defaultBranch ?? null,
    }));
    result.checks.push({ name: "repositories", ok: true, detail: `${result.repositories.length} repositories` });
  } catch (error) {
    result.checks.push({ name: "repositories", ok: false, detail: `${describe(error)} (the token needs Code (Read) scope)` });
  }

  result.ok = result.checks.every((check) => check.ok);
  return result;
}
