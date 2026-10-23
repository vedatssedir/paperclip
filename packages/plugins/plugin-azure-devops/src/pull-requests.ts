/**
 * Azure Repos pull request support: the `azure_create_pull_request` agent
 * tool, the `pr-status` job that closes Paperclip issues whose PR merged, and
 * the `test-connection` action.
 */

import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import { createAzureReposClient, testAzureConnection, type AzureReposClient } from "./azure-repos.js";
import { CREATE_PR_TOOL_NAME, ISSUE_ORIGIN_KIND, PR_STATUS_JOB_KEY } from "./manifest.js";
import { parseSettings, type AzureSettings } from "./mapping.js";

const PR_NAMESPACE = "pull-requests";
const PR_INDEX_KEY = "pull-request-index";

export interface TrackedPullRequest {
  issueId: string;
  repositoryId: string;
  repositoryName: string;
  pullRequestId: number;
  url: string;
  workItemId: number | null;
  createdAt: string;
}

function prState(companyId: string, stateKey: string, namespace?: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey, ...(namespace ? { namespace } : {}) };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripRef(ref: string | undefined | null) {
  return (ref ?? "").replace(/^refs\/heads\//, "");
}

async function connectionFor(ctx: PluginContext, companyId: string) {
  const settings: AzureSettings | null = parseSettings(await ctx.config.get(companyId));
  if (!settings) throw new Error("Azure DevOps settings are incomplete");
  const pat = await ctx.secrets.resolve(settings.personalAccessToken as never, {
    companyId,
    configPath: "personalAccessToken",
  });
  return {
    settings,
    options: {
      organizationUrl: settings.organizationUrl,
      project: settings.project,
      pat,
      fetch: (url: string, init?: RequestInit) => ctx.http.fetch(url, init),
    },
  };
}

async function readIndex(ctx: PluginContext, companyId: string): Promise<string[]> {
  const value = await ctx.state.get(prState(companyId, PR_INDEX_KEY));
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function trackPullRequest(ctx: PluginContext, companyId: string, tracked: TrackedPullRequest) {
  await ctx.state.set(prState(companyId, tracked.issueId, PR_NAMESPACE), tracked);
  const index = await readIndex(ctx, companyId);
  if (!index.includes(tracked.issueId)) await ctx.state.set(prState(companyId, PR_INDEX_KEY), [...index, tracked.issueId]);
}

async function untrackPullRequest(ctx: PluginContext, companyId: string, issueId: string) {
  await ctx.state.delete(prState(companyId, issueId, PR_NAMESPACE));
  const index = await readIndex(ctx, companyId);
  await ctx.state.set(prState(companyId, PR_INDEX_KEY), index.filter((entry) => entry !== issueId));
}

export interface CreatePullRequestInput {
  issueId: string;
  repository: string;
  sourceBranch: string;
  targetBranch?: string | null;
  title?: string | null;
  description?: string | null;
}

export async function createPullRequestForIssue(
  ctx: PluginContext,
  companyId: string,
  input: CreatePullRequestInput,
  repos?: AzureReposClient,
): Promise<TrackedPullRequest> {
  const issue = await ctx.issues.get(input.issueId, companyId);
  if (!issue) throw new Error(`Issue ${input.issueId} not found`);
  const client = repos ?? createAzureReposClient((await connectionFor(ctx, companyId)).options);

  const repository = await client.getRepository(input.repository);
  const defaultBranch = stripRef(repository.defaultBranch) || "main";
  const sourceBranch = stripRef(input.sourceBranch);
  const targetBranch = stripRef(input.targetBranch) || defaultBranch;
  if (sourceBranch === defaultBranch || sourceBranch === targetBranch) {
    throw new Error(`Source branch ${sourceBranch} must be a feature branch, not ${targetBranch}. Push your work to a task branch first.`);
  }

  const workItemId = issue.originKind === ISSUE_ORIGIN_KIND && issue.originId ? Number(issue.originId) || null : null;
  const reference = issue.identifier ?? issue.id;
  const title = (input.title || `${reference}: ${issue.title}`).slice(0, 400);
  const description = (input.description || `Implements Paperclip task ${reference}.`).slice(0, 4000);

  const pr = await client.createPullRequest(repository.id, sourceBranch, targetBranch, title, description, workItemId);
  const tracked: TrackedPullRequest = {
    issueId: issue.id,
    repositoryId: repository.id,
    repositoryName: repository.name,
    pullRequestId: pr.pullRequestId,
    url: client.pullRequestWebUrl(repository.name, pr.pullRequestId),
    workItemId,
    createdAt: new Date().toISOString(),
  };
  await trackPullRequest(ctx, companyId, tracked);
  await ctx.issues.createComment(
    issue.id,
    `Opened Azure Repos pull request [#${pr.pullRequestId}](${tracked.url}) from \`${sourceBranch}\` into \`${targetBranch}\`${workItemId ? ` linked to work item ${workItemId}` : ""}.`,
    companyId,
  );
  await ctx.activity.log({
    companyId,
    entityType: "issue",
    entityId: issue.id,
    message: `Azure pull request #${pr.pullRequestId} opened for ${reference}`,
    metadata: { pullRequestId: pr.pullRequestId, repository: repository.name, workItemId },
  });
  return tracked;
}

/** Marks Paperclip issues done when their tracked PR completed; drops abandoned PRs. */
export async function checkPullRequestStatuses(ctx: PluginContext, companyId: string, repos?: AzureReposClient) {
  const index = await readIndex(ctx, companyId);
  if (index.length === 0) return { checked: 0, completed: 0 };
  const client = repos ?? createAzureReposClient((await connectionFor(ctx, companyId)).options);
  let completed = 0;
  for (const issueId of index) {
    const tracked = (await ctx.state.get(prState(companyId, issueId, PR_NAMESPACE))) as TrackedPullRequest | null;
    if (!tracked) {
      await untrackPullRequest(ctx, companyId, issueId);
      continue;
    }
    try {
      const pr = await client.getPullRequest(tracked.repositoryId, tracked.pullRequestId);
      if (pr.status === "completed") {
        const issue = await ctx.issues.get(issueId, companyId);
        if (issue && issue.status !== "done" && issue.status !== "cancelled") {
          await ctx.issues.update(issueId, { status: "done" }, companyId);
          await ctx.issues.createComment(issueId, `Pull request [#${tracked.pullRequestId}](${tracked.url}) was merged.`, companyId);
          completed += 1;
        }
        await untrackPullRequest(ctx, companyId, issueId);
      } else if (pr.status === "abandoned") {
        await ctx.issues.createComment(issueId, `Pull request [#${tracked.pullRequestId}](${tracked.url}) was abandoned.`, companyId);
        await untrackPullRequest(ctx, companyId, issueId);
      }
    } catch (error) {
      ctx.logger.warn("Azure pull request status check failed", { companyId, issueId, error: message(error) });
    }
  }
  return { checked: index.length, completed };
}

function companyIdParam(params: Record<string, unknown>) {
  return requireString(params.companyId, "companyId");
}

export function registerPullRequestFeatures(ctx: PluginContext) {
  const declaration = ctx.manifest.tools?.find((tool) => tool.name === CREATE_PR_TOOL_NAME);
  ctx.tools.register(
    CREATE_PR_TOOL_NAME,
    {
      displayName: declaration?.displayName ?? "Create Azure pull request",
      description: declaration?.description ?? "Open an Azure Repos pull request for the current task.",
      parametersSchema: declaration?.parametersSchema ?? { type: "object" },
    },
    async (params, runCtx): Promise<ToolResult> => {
      try {
        const input = (params ?? {}) as Record<string, unknown>;
        const tracked = await createPullRequestForIssue(ctx, runCtx.companyId, {
          issueId: requireString(input.issueId, "issueId"),
          repository: requireString(input.repository, "repository"),
          sourceBranch: requireString(input.sourceBranch, "sourceBranch"),
          targetBranch: optionalString(input.targetBranch),
          title: optionalString(input.title),
          description: optionalString(input.description),
        });
        return { content: `Opened pull request #${tracked.pullRequestId}: ${tracked.url}`, data: tracked };
      } catch (error) {
        return { error: message(error) };
      }
    },
  );

  ctx.jobs.register(PR_STATUS_JOB_KEY, async () => {
    for (const company of await ctx.companies.list()) {
      await checkPullRequestStatuses(ctx, company.id).catch((error) => {
        ctx.logger.warn("Azure pull request status job failed", { companyId: company.id, error: message(error) });
      });
    }
  });

  ctx.actions.register("test-connection", async (params) => {
    const companyId = companyIdParam(params);
    try {
      return await testAzureConnection((await connectionFor(ctx, companyId)).options);
    } catch (error) {
      return { ok: false, checks: [{ name: "pat", ok: false, detail: message(error) }], project: null, teams: [], repositories: [] };
    }
  });
}
