import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { createAzureClient, type AzureClient, type AzureWorkItem } from "./azure-client.js";
import { ISSUE_ORIGIN_KIND, PLUGIN_ID, SYNC_JOB_KEY, WORK_ITEM_WEBHOOK_KEY } from "./manifest.js";
import { buildSyncQuery, initialTaskPlacement, parseServiceHook, verifyWebhookSecret } from "./sync-guards.js";
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

const SYNC_STATUS_KEY = "sync-status";
const AGENT_STATUS_KEY = "agent-sync-status";
const KNOWN_STATUS_NAMESPACE = "known-status";

interface SyncStatus {
  lastSyncAt: string | null;
  /** Start time of the last sync that saw every matching item; drives incremental queries. */
  lastSuccessfulSyncAt: string | null;
  trigger: string | null;
  created: number;
  updated: number;
  /** New work items not imported because maxNewTasksPerSync was reached. */
  deferred: number;
  /** True when maxWorkItemsPerSync cut the query result. */
  truncated: boolean;
  error: string | null;
}

let currentContext: PluginContext | null = null;

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

type ItemOutcome = "created" | "updated" | "unchanged" | "deferred";

async function syncWorkItem(
  ctx: PluginContext,
  companyId: string,
  settings: AzureSettings,
  azure: AzureClient,
  item: AzureWorkItem,
  allowCreate: boolean,
): Promise<ItemOutcome> {
  const title = issueTitle(item);
  const description = issueDescription(item, {
    webUrl: azure.workItemWebUrl(item.id),
    organizationUrl: settings.organizationUrl,
    project: settings.project,
    allowedRepositories: settings.allowedRepositories,
  });
  const azureStatus = paperclipStatusForAzureState(String(item.fields["System.State"] ?? ""));
  const existing = await findIssueForWorkItem(ctx, companyId, item.id);

  if (!existing) {
    if (!allowCreate) return "deferred";
    const placement = initialTaskPlacement({
      azureStatus,
      assigneeAgentId: await resolveDeveloperAgentId(ctx, companyId, assignedUniqueName(item)),
      requireTriage: settings.requireTriage,
    });
    const issue = await ctx.issues.create({
      companyId,
      projectId: settings.paperclipProjectId ?? undefined,
      title,
      description,
      status: placement.status,
      priority: priorityForAzure(item.fields["Microsoft.VSTS.Common.Priority"]),
      assigneeAgentId: placement.assigneeAgentId,
      originKind: ISSUE_ORIGIN_KIND,
      originId: String(item.id),
    });
    await ctx.state.set(companyState(companyId, issue.id, KNOWN_STATUS_NAMESPACE), issue.status);
    return "created";
  }

  // Azure owns title and description. Status only follows Azure when the work item is
  // finished there, so Azure edits never interrupt an agent mid-run.
  const patch: Parameters<PluginContext["issues"]["update"]>[1] = {};
  if (existing.title !== title) patch.title = title;
  if (existing.description !== description) patch.description = description;
  if ((azureStatus === "done" || azureStatus === "cancelled") && existing.status !== azureStatus) {
    patch.status = azureStatus;
  }
  if (Object.keys(patch).length === 0) return "unchanged";
  const issue = await ctx.issues.update(existing.id, patch, companyId);
  await ctx.state.set(companyState(companyId, issue.id, KNOWN_STATUS_NAMESPACE), issue.status);
  return "updated";
}

async function syncBoard(ctx: PluginContext, companyId: string, trigger: string): Promise<SyncStatus> {
  const previous = (await ctx.state.get(companyState(companyId, SYNC_STATUS_KEY))) as Partial<SyncStatus> | null;
  const startedAt = new Date().toISOString();
  const status: SyncStatus = {
    lastSyncAt: startedAt,
    lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt ?? null,
    trigger,
    created: 0,
    updated: 0,
    deferred: 0,
    truncated: false,
    error: null,
  };
  try {
    const settings = await loadSettings(ctx, companyId);
    if (!settings) throw new Error("Azure DevOps settings are incomplete");
    const azure = await clientFor(ctx, companyId, settings);
    const query = buildSyncQuery(settings.workItemQuery, status.lastSuccessfulSyncAt);
    const teams = settings.teams.length > 0 ? settings.teams : [undefined];
    const ids = new Set<number>();
    for (const team of teams) {
      for (const id of await azure.queryWorkItemIds(query, team, settings.maxWorkItemsPerSync + 1)) ids.add(id);
    }
    const allIds = [...ids];
    status.truncated = allIds.length > settings.maxWorkItemsPerSync;
    const items = await azure.getWorkItems(allIds.slice(0, settings.maxWorkItemsPerSync));

    for (const item of items) {
      const outcome = await syncWorkItem(ctx, companyId, settings, azure, item, status.created < settings.maxNewTasksPerSync);
      if (outcome === "created") status.created += 1;
      else if (outcome === "updated") status.updated += 1;
      else if (outcome === "deferred") status.deferred += 1;
    }
    // Only advance the incremental watermark when nothing was left behind.
    if (!status.truncated && status.deferred === 0) status.lastSuccessfulSyncAt = startedAt;
  } catch (error) {
    status.error = errorMessage(error);
    ctx.logger.warn("Azure Boards sync failed", { companyId, error: status.error });
  }
  await ctx.state.set(companyState(companyId, SYNC_STATUS_KEY), status);
  if (status.created > 0 || status.updated > 0 || status.deferred > 0 || status.error) {
    await ctx.activity.log({
      companyId,
      message: status.error
        ? `Azure Boards sync failed: ${status.error}`
        : `Azure Boards sync created ${status.created} and updated ${status.updated} tasks`
          + (status.deferred > 0 ? `; ${status.deferred} new work items deferred by maxNewTasksPerSync` : ""),
      metadata: { ...status },
    });
  }
  return status;
}

/** Handles an Azure DevOps Service Hook for one work item. */
async function handleWorkItemWebhook(ctx: PluginContext, input: PluginWebhookInput) {
  const hook = parseServiceHook(input.parsedBody ?? safeJson(input.rawBody));
  let authenticated = false;
  for (const company of await ctx.companies.list()) {
    const settings = await loadSettings(ctx, company.id).catch(() => null);
    if (!settings?.webhookSecret) continue;
    const secret = await ctx.secrets
      .resolve(settings.webhookSecret as never, { companyId: company.id, configPath: "webhookSecret" })
      .catch(() => "");
    if (!verifyWebhookSecret(input.headers, secret)) continue;
    authenticated = true;
    if (!hook || !settings.syncEnabled) continue;
    if (hook.project && hook.project.toLowerCase() !== settings.project.toLowerCase()) continue;
    const azure = await clientFor(ctx, company.id, settings);
    const [item] = await azure.getWorkItems([hook.workItemId]);
    if (!item) continue;
    const outcome = await syncWorkItem(ctx, company.id, settings, azure, item, true);
    if (outcome === "created" || outcome === "updated") {
      await ctx.activity.log({
        companyId: company.id,
        message: `Azure Boards webhook ${outcome} task for work item #${item.id}`,
        metadata: { workItemId: item.id, requestId: input.requestId },
      });
    }
  }
  if (!authenticated) throw new Error("Webhook secret verification failed");
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function managedDeveloperAgents(ctx: PluginContext, companyId: string) {
  const agents = await ctx.agents.list({ companyId, limit: 500 });
  return agents.filter((agent) => {
    const metadata = (agent as { metadata?: Record<string, unknown> | null }).metadata;
    const managed = metadata?.paperclipManagedResource as { pluginKey?: unknown } | undefined;
    return managed?.pluginKey === PLUGIN_ID;
  });
}

async function setDeveloperAgentsPaused(ctx: PluginContext, companyId: string, paused: boolean) {
  const results: Array<{ agentId: string; status: string; error?: string }> = [];
  for (const agent of await managedDeveloperAgents(ctx, companyId)) {
    if (agent.status === "terminated") continue;
    if (paused ? agent.status === "paused" : agent.status !== "paused") continue;
    try {
      const updated = paused ? await ctx.agents.pause(agent.id, companyId) : await ctx.agents.resume(agent.id, companyId);
      results.push({ agentId: agent.id, status: updated.status });
    } catch (error) {
      results.push({ agentId: agent.id, status: agent.status, error: errorMessage(error) });
    }
  }
  await ctx.activity.log({
    companyId,
    message: `Azure DevOps ${paused ? "paused" : "resumed"} ${results.filter((result) => !result.error).length} developer agents`,
    metadata: { agents: results },
  });
  return { agents: results };
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
      ...(settings.agentMonthlyBudgetCents !== null ? { budgetMonthlyCents: settings.agentMonthlyBudgetCents } : {}),
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
    currentContext = ctx;
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
    ctx.actions.register("pause-all-agents", async (params) => setDeveloperAgentsPaused(ctx, companyIdParam(params), true));
    ctx.actions.register("resume-all-agents", async (params) => setDeveloperAgentsPaused(ctx, companyIdParam(params), false));

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

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WORK_ITEM_WEBHOOK_KEY) throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    if (!currentContext) throw new Error("Plugin is not ready");
    await handleWorkItemWebhook(currentContext, input);
  },

  async onHealth() {
    return { status: "ok", message: "Azure DevOps plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
