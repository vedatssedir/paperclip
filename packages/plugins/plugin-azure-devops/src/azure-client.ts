/**
 * Minimal Azure DevOps REST client: only the calls the board sync and agent
 * provisioning need. Authenticates with a PAT over HTTP Basic auth.
 */

export const AZURE_API_VERSION = "7.1";

export interface AzureWorkItem {
  id: number;
  rev: number;
  url: string;
  fields: Record<string, unknown>;
}

export interface AzureTeam {
  id: string;
  name: string;
}

export interface AzureTeamMember {
  id: string;
  displayName: string;
  uniqueName: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const WORK_ITEM_FIELDS = [
  "System.Id",
  "System.Title",
  "System.Description",
  "System.State",
  "System.WorkItemType",
  "System.AssignedTo",
  "System.Tags",
  "System.TeamProject",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.TCM.ReproSteps",
];

export function createAzureClient(options: { organizationUrl: string; project: string; pat: string; fetch: Fetch }) {
  const base = options.organizationUrl.replace(/\/+$/, "");
  const project = encodeURIComponent(options.project);
  const authorization = `Basic ${Buffer.from(`:${options.pat}`).toString("base64")}`;

  async function request<T>(path: string, init: { method?: string; body?: unknown; contentType?: string; apiVersion?: string } = {}): Promise<T> {
    const separator = path.includes("?") ? "&" : "?";
    const response = await options.fetch(`${base}${path}${separator}api-version=${init.apiVersion ?? AZURE_API_VERSION}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": init.contentType ?? "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!response.ok) {
      // Provider error bodies can echo request details; report status only.
      throw new Error(`Azure DevOps request failed: ${init.method ?? "GET"} ${path.split("?")[0]} → HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  return {
    async queryWorkItemIds(wiql: string, team?: string): Promise<number[]> {
      const scope = team ? `/${project}/${encodeURIComponent(team)}` : `/${project}`;
      const result = await request<{ workItems?: Array<{ id: number }> }>(`${scope}/_apis/wit/wiql?$top=200`, {
        method: "POST",
        body: { query: wiql },
      });
      return (result.workItems ?? []).map((item) => item.id);
    },

    async getWorkItems(ids: number[]): Promise<AzureWorkItem[]> {
      const items: AzureWorkItem[] = [];
      for (let index = 0; index < ids.length; index += 200) {
        const result = await request<{ value: AzureWorkItem[] }>(`/${project}/_apis/wit/workitemsbatch`, {
          method: "POST",
          body: { ids: ids.slice(index, index + 200), fields: WORK_ITEM_FIELDS },
        });
        items.push(...result.value);
      }
      return items;
    },

    async updateWorkItemState(id: number, state: string): Promise<void> {
      await request(`/${project}/_apis/wit/workitems/${id}`, {
        method: "PATCH",
        contentType: "application/json-patch+json",
        body: [{ op: "add", path: "/fields/System.State", value: state }],
      });
    },

    async addWorkItemComment(id: number, text: string): Promise<void> {
      await request(`/${project}/_apis/wit/workItems/${id}/comments`, {
        method: "POST",
        body: { text },
        apiVersion: "7.1-preview.4",
      });
    },

    async listTeams(): Promise<AzureTeam[]> {
      const result = await request<{ value: AzureTeam[] }>(`/_apis/projects/${project}/teams?$top=500`);
      return result.value;
    },

    async listTeamMembers(team: string): Promise<AzureTeamMember[]> {
      const result = await request<{ value: Array<{ identity: AzureTeamMember }> }>(
        `/_apis/projects/${project}/teams/${encodeURIComponent(team)}/members?$top=500`,
      );
      return result.value.map((member) => member.identity);
    },

    workItemWebUrl(id: number) {
      return `${base}/${project}/_workitems/edit/${id}`;
    },
  };
}

export type AzureClient = ReturnType<typeof createAzureClient>;
