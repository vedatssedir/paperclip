import type { AzureIdentityRef, AzureWorkItem } from "./client.js";

/** States in which a work item is finished and must not be worked by an agent. */
export const CLOSED_STATES = ["Closed", "Done", "Removed", "Resolved", "Completed", "Cut"];

export interface WorkItemRow {
  azureId: number;
  rev: number;
  type: string;
  title: string;
  state: string;
  assignedToUniqueName: string | null;
  assignedToDisplayName: string | null;
  areaPath: string | null;
  iterationPath: string | null;
  priority: number | null;
  tags: string[];
  repoNames: string[];
  descriptionHtml: string;
  changedAt: Date;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseTags(value: unknown): string[] {
  return text(value).split(";").map((tag) => tag.trim()).filter(Boolean);
}

/** Tags written `repo:<name>` name the repositories a work item changes. */
export function repoNamesFromTags(tags: string[]): string[] {
  return [...new Set(tags.filter((tag) => /^repo:/i.test(tag)).map((tag) => tag.slice(5).trim()).filter(Boolean))];
}

export function toWorkItemRow(item: AzureWorkItem): WorkItemRow {
  const fields = item.fields;
  const assigned = fields["System.AssignedTo"] as AzureIdentityRef | undefined;
  const tags = parseTags(fields["System.Tags"]);
  const priority = Number(fields["Microsoft.VSTS.Common.Priority"]);
  const changed = Date.parse(text(fields["System.ChangedDate"]));
  return {
    azureId: item.id,
    rev: item.rev,
    type: text(fields["System.WorkItemType"]) || "Work Item",
    title: text(fields["System.Title"]) || `Work item ${item.id}`,
    state: text(fields["System.State"]) || "New",
    assignedToUniqueName: assigned?.uniqueName?.toLowerCase() ?? null,
    assignedToDisplayName: assigned?.displayName ?? null,
    areaPath: text(fields["System.AreaPath"]) || null,
    iterationPath: text(fields["System.IterationPath"]) || null,
    priority: Number.isFinite(priority) ? priority : null,
    tags,
    repoNames: repoNamesFromTags(tags),
    descriptionHtml: text(fields["System.Description"]),
    changedAt: Number.isNaN(changed) ? new Date() : new Date(changed),
  };
}

/** Default reconciliation query: open items, or anything changed since the last sync. */
export function reconciliationQuery(since: Date | null): string {
  const changed = since
    ? `[System.ChangedDate] >= '${since.toISOString().slice(0, 10)}'`
    : "[System.ChangedDate] >= @today - 90";
  return "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project "
    + `AND (${changed} OR [System.State] NOT IN (${CLOSED_STATES.map((state) => `'${state}'`).join(", ")})) `
    + "ORDER BY [System.ChangedDate] DESC";
}

export function branchName(azureId: number, title: string): string {
  const slug = title.toLowerCase().replace(/ı/g, "i").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `ab/${azureId}${slug ? `-${slug}` : ""}`;
}

export function stripRefs(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}
