import type { AzureWorkItem } from "./azure-client.js";
import { DEVELOPER_AGENT_KEY } from "./manifest.js";

export type PaperclipStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
export type PaperclipPriority = "critical" | "high" | "medium" | "low";

export interface AzureSettings {
  organizationUrl: string;
  project: string;
  personalAccessToken: unknown;
  teams: string[];
  paperclipProjectId: string | null;
  workItemQuery: string;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  inProgressState: string;
  doneState: string;
  defaultAgentSkills: string[];
}

export const DEFAULT_WORK_ITEM_QUERY =
  "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project "
  + "AND [System.State] NOT IN ('Closed', 'Done', 'Removed') AND [System.ChangedDate] >= @today - 30 "
  + "ORDER BY [System.ChangedDate] DESC";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

/** Returns null when required settings are missing, so unconfigured companies are skipped. */
export function parseSettings(config: Record<string, unknown>): AzureSettings | null {
  const organizationUrl = text(config.organizationUrl);
  const project = text(config.project);
  if (!organizationUrl || !project || !config.personalAccessToken) return null;
  const interval = Number(config.syncIntervalMinutes);
  return {
    organizationUrl,
    project,
    personalAccessToken: config.personalAccessToken,
    teams: stringList(config.teams),
    paperclipProjectId: text(config.paperclipProjectId) || null,
    workItemQuery: text(config.workItemQuery) || DEFAULT_WORK_ITEM_QUERY,
    syncEnabled: config.syncEnabled !== false,
    syncIntervalMinutes: Number.isFinite(interval) && interval >= 1 ? interval : 15,
    inProgressState: text(config.inProgressState) || "Active",
    doneState: text(config.doneState) || "Closed",
    defaultAgentSkills: stringList(config.defaultAgentSkills),
  };
}

export function isSyncDue(lastSyncAt: string | null | undefined, intervalMinutes: number, now: Date): boolean {
  if (!lastSyncAt) return true;
  const last = Date.parse(lastSyncAt);
  return Number.isNaN(last) || now.getTime() - last >= intervalMinutes * 60_000;
}

/** Maps Azure states from the Agile, Scrum, CMMI and Basic processes. */
export function paperclipStatusForAzureState(state: string): PaperclipStatus {
  switch (state.trim().toLowerCase()) {
    case "active":
    case "committed":
    case "doing":
    case "in progress":
      return "in_progress";
    case "resolved":
      return "in_review";
    case "closed":
    case "done":
      return "done";
    case "removed":
      return "cancelled";
    default:
      return "todo";
  }
}

export function azureStateForPaperclipStatus(status: string, settings: Pick<AzureSettings, "inProgressState" | "doneState">): string | null {
  if (status === "in_progress") return settings.inProgressState;
  if (status === "done") return settings.doneState;
  return null;
}

export function priorityForAzure(value: unknown): PaperclipPriority {
  const priority = Number(value);
  if (priority === 1) return "critical";
  if (priority === 2) return "high";
  if (priority === 4) return "low";
  return "medium";
}

/** Stable managed-agent key for one Azure identity. */
export function developerAgentKey(uniqueName: string): string {
  const slug = uniqueName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 80);
  return `${DEVELOPER_AGENT_KEY}:${slug || "unknown"}`;
}

export function assignedUniqueName(item: AzureWorkItem): string | null {
  const assigned = item.fields["System.AssignedTo"];
  if (assigned && typeof assigned === "object") return text((assigned as Record<string, unknown>).uniqueName) || null;
  return null;
}

/** Tags written as `repo:<name>` name the repositories a work item changes. */
export function repositoriesFromTags(tags: unknown): string[] {
  return text(tags)
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.toLowerCase().startsWith("repo:"))
    .map((tag) => tag.slice("repo:".length).trim())
    .filter(Boolean);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function issueTitle(item: AzureWorkItem): string {
  return `[AB#${item.id}] ${text(item.fields["System.Title"]) || "Untitled work item"}`;
}

export function issueDescription(item: AzureWorkItem, input: { webUrl: string; organizationUrl: string; project: string }): string {
  const repos = repositoriesFromTags(item.fields["System.Tags"]);
  const body = htmlToText(text(item.fields["System.Description"]) || text(item.fields["Microsoft.VSTS.TCM.ReproSteps"]));
  const base = input.organizationUrl.replace(/\/+$/, "");
  const lines = [
    `Azure Boards ${text(item.fields["System.WorkItemType"]) || "work item"} [#${item.id}](${input.webUrl}) · state: ${text(item.fields["System.State"]) || "unknown"}`,
    "",
  ];
  if (repos.length > 0) {
    lines.push("## Repositories", "");
    for (const repo of repos) {
      lines.push(`- ${repo}: ${base}/${encodeURIComponent(input.project)}/_git/${encodeURIComponent(repo)}`);
    }
    lines.push("");
  }
  lines.push("## Description", "", body || "_No description._");
  return lines.join("\n");
}
