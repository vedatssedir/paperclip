import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { createAzureClient } from "./azure-client.js";
import { ISSUE_ORIGIN_KIND, SYNC_JOB_KEY } from "./manifest.js";
import {
  assignedUniqueName,
  azureStateForPaperclipStatus,
  developerAgentKey,
  isSyncDue,
  issueDescription,
  issueTitle,
  paperclipStatusForAzureState,
  parseSettings,
  priorityForAzure,
  type AzureSettings,
} from "./mapping.js";
import { registerPullRequestFeatures } from "./pull-requests.js";

const SYNC_STATUS_KEY = "sync-status";
const AGENT_STATUS_KEY = "agent-sync-status";
const KNOWN_STATUS_NAMESPACE = "known-status";

interface SyncStatus {
  lastSyncAt: string | null;
  trigger: string | null;
  created: number;
  updated: number;
  error: string | null;
}

function companyState(companyId: string, stateKey: string, namespace?: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey, ...(namespace ? { namespace } : {}) };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function loadSettings(ctx: PluginContext, companyId: string): Promise<AzureSettings | null> {
  return parseSettings(await ctx.config.get(companyId));
}

async function clientFor(ctx: PluginContext, companyId: string, settings: AzureSettings) {
  const pat = await ctx.secrets.resolve(settings.personalAccessToken as never, {
    companyId,
    configPath: "personalAccessToken",
  });
  return createAzureClient({
    organizationUrl: settings.organizationUrl,
    project: settings.project,
    pat,
    fetch: (url, init) => ctx.http.fetch(url, init),
  });
}

async function findIssueForWorkItem(ctx: PluginContext, companyId: string, workItemId: number) {
  const [issue] = await ctx.issues.list({
    companyId,
    originKind: ISSUE_ORIGIN_KIND,
    originId: String(workItemId),
    limit: 1,
  });
  return issue ?? null;
}

async function resolveDeveloperAgentId(ctx: PluginContext, companyId: string, uniqueName: string | null) {
  if (!uniqueName) return undefined;
  const resolution = await ctx.agents.managed.get(developerAgentKey(uniqueName), companyId).catch(() => null);
  return resolution?.agentId ?? undefined;
}

async function syncBoard(ctx: PluginContext, companyId: string, trigger: string): Promise<SyncStatus> {
  const status: SyncStatus = { lastSyncAt: new Date().toISOString(), trigger, created: 0, updated: 0, error: null };
  try {
    const settings = await loadSettings(ctx, companyId);
    if (!settings) throw new Error("Azure DevOps settings are incomplete");
    const azure = await clientFor(ctx, companyId, settings);
    const teams = settings.teams.length > 0 ? settings.teams : [undefined];
    const ids = new Set<number>();
    for (const team of teams) {
      for (const id of await azure.queryWorkItemIds(settings.workItemQuery, team)) ids.add(id);
    }
    const items = await azure.getWorkItems([...ids]);

    for (const item of items) {
      const title = issueTitle(item);
      const description = issueDescription(item, {
        webUrl: azure.workItemWebUrl(item.id),
        organizationUrl: settings.organizationUrl,
        project: settings.project,
      });
      const azureStatus = paperclipStatusForAzureState(String(item.fields["System.State"] ?? ""));
      const existing = await findIssueForWorkItem(ctx, companyId, item.id);

      if (!existing) {
        const issue = await ctx.issues.create({
          companyId,
          projectId: settings.paperclipProjectId ?? undefined,
          title,
          description,
          status: azureStatus === "done" || azureStatus === "cancelled" ? azureStatus : "todo",
          priority: priorityForAzure(item.fields["Microsoft.VSTS.Common.Priority"]),
          assigneeAgentId: await resolveDeveloperAgentId(ctx, companyId, assignedUniqueName(item)),
          originKind: ISSUE_ORIGIN_KIND,
          originId: String(item.id),
        });
        await ctx.state.set(companyState(companyId, issue.id, KNOWN_STATUS_NAMESPACE), issue.status);
        status.created += 1;
        continue;
      }

      // Azure owns title and description. Status only follows Azure when the work item is
      // finished there, so Azure edits never interrupt an agent mid-run.
      const patch: Parameters<PluginContext["issues"]["update"]>[1] = {};
      if (existing.title !== title) patch.title = title;
      if (existing.description !== description) patch.description = description;
      if ((azureStatus === "done" || azureStatus === "cancelled") && existing.status !== azureStatus) {
        patch.status = azureStatus;
      }
      if (Object.keys(patch).length === 0) continue;
      const issue = await ctx.issues.update(existing.id, patch, companyId);
      await ctx.state.set(companyState(companyId, issue.id, KNOWN_STATUS_NAMESPACE), issue.status);
      status.updated += 1;
    }
  } catch (error) {
    status.error = errorMessage(error);
    ctx.logger.warn("Azure Boards sync failed", { companyId, error: status.error });
  }
  await ctx.state.set(companyState(companyId, SYNC_STATUS_KEY), status);
  if (status.created > 0 || status.updated > 0 || status.error) {
    await ctx.activity.log({
      companyId,
      message: status.error
        ? `Azure Boards sync failed: ${status.error}`
        : `Azure Boards sync created ${status.created} and updated ${status.updated} tasks`,
      metadata: { ...status },
    });
  }
  return status;
}

async function syncTeamAgents(ctx: PluginContext, companyId: string) {
  const settings = await loadSettings(ctx, companyId);
  if (!settings) throw new Error("Azure DevOps settings are incomplete");
  const azure = await clientFor(ctx, companyId, settings);
  const teams = settings.teams.length > 0 ? settings.teams : (await azure.listTeams()).map((team) => team.name);

  const members = new Map<string, { displayName: string; uniqueName: string; teams: string[] }>();
  for (const team of teams) {
    for (const member of await azure.listTeamMembers(team)) {
      const entry = members.get(member.uniqueName) ?? { displayName: member.displayName, uniqueName: member.uniqueName, teams: [] };
      entry.teams.push(team);
      members.set(member.uniqueName, entry);
    }
  }

  const results: Array<{ uniqueName: string; agentId: string | null; status: string }> = [];
  for (const member of members.values()) {
    const resolution = await ctx.agents.managed.reconcile(developerAgentKey(member.uniqueName), companyId, {
      displayName: member.displayName.slice(0, 100),
      title: `Developer · ${member.teams.join(", ")}`.slice(0, 200),
      capabilities: `Azure DevOps developer agent for ${member.uniqueName}.`,
      desiredSkills: settings.defaultAgentSkills,
    });
    results.push({ uniqueName: member.uniqueName, agentId: resolution.agentId, status: resolution.status });
  }
  const summary = { syncedAt: new Date().toISOString(), teams, agents: results };
  await ctx.state.set(companyState(companyId, AGENT_STATUS_KEY), summary);
  await ctx.activity.log({
    companyId,
    message: `Azure DevOps developer agents synced for ${results.length} team members`,
    metadata: { teams, created: results.filter((result) => result.status === "created").length },
  });
  return summary;
}

async function pushStatusToAzure(ctx: PluginContext, companyId: string, issueId: string) {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue || issue.originKind !== ISSUE_ORIGIN_KIND || !issue.originId) return;
  const knownKey = companyState(companyId, issue.id, KNOWN_STATUS_NAMESPACE);
  if ((await ctx.state.get(knownKey)) === issue.status) return;
  await ctx.state.set(knownKey, issue.status);

  const settings = await loadSettings(ctx, companyId);
  if (!settings) return;
  const azure = await clientFor(ctx, companyId, settings);
  const workItemId = Number(issue.originId);
  const state = azureStateForPaperclipStatus(issue.status, settings);
  if (state) await azure.updateWorkItemState(workItemId, state);
  if (issue.status === "in_review" || issue.status === "done") {
    await azure.addWorkItemComment(workItemId, `Paperclip task ${issue.identifier ?? issue.id} moved to ${issue.status}.`);
  }
}

function companyIdParam(params: Record<string, unknown>) {
  const companyId = typeof params.companyId === "string" ? params.companyId : "";
  if (!companyId) throw new Error("companyId is required");
  return companyId;
}

const plugin = definePlugin({
  async setup(ctx) {
    registerPullRequestFeatures(ctx);

    ctx.jobs.register(SYNC_JOB_KEY, async (job) => {
      const now = new Date();
      for (const company of await ctx.companies.list()) {
        const settings = await loadSettings(ctx, company.id).catch(() => null);
        if (!settings?.syncEnabled) continue;
        const last = (await ctx.state.get(companyState(company.id, SYNC_STATUS_KEY))) as SyncStatus | null;
        if (job.trigger === "schedule" && !isSyncDue(last?.lastSyncAt, settings.syncIntervalMinutes, now)) continue;
        await syncBoard(ctx, company.id, job.trigger);
      }
    });

    ctx.events.on("issue.updated", async (event) => {
      if (!event.entityId) return;
      await pushStatusToAzure(ctx, event.companyId, event.entityId).catch((error) => {
        ctx.logger.warn("Azure status push failed", { issueId: event.entityId, error: errorMessage(error) });
      });
    });

    ctx.actions.register("sync-now", async (params) => syncBoard(ctx, companyIdParam(params), "manual"));
    ctx.actions.register("sync-agents", async (params) => syncTeamAgents(ctx, companyIdParam(params)));

    ctx.data.register("status", async (params) => {
      const companyId = companyIdParam(params);
      const settings = await loadSettings(ctx, companyId);
      return {
        configured: Boolean(settings),
        syncEnabled: settings?.syncEnabled ?? false,
        syncIntervalMinutes: settings?.syncIntervalMinutes ?? null,
        board: await ctx.state.get(companyState(companyId, SYNC_STATUS_KEY)),
        agents: await ctx.state.get(companyState(companyId, AGENT_STATUS_KEY)),
      };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Azure DevOps plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
