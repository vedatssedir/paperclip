import {
  ActionBar,
  KeyValueList,
  Spinner,
  usePluginData,
  usePluginToast,
  type PluginCompanySettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

interface StatusData {
  configured: boolean;
  syncEnabled: boolean;
  syncIntervalMinutes: number | null;
  board: { lastSyncAt: string | null; trigger: string | null; created: number; updated: number; error: string | null } | null;
  agents: { syncedAt: string; teams: string[]; agents: Array<{ uniqueName: string; status: string }> } | null;
}

export function AzureDevOpsSettingsPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId;
  const status = usePluginData<StatusData>("status", companyId ? { companyId } : {});
  const toast = usePluginToast();
  if (!companyId) return null;
  if (status.loading && !status.data) return <Spinner />;
  const data = status.data;

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <p>
        Set the organization URL, project, personal access token and teams in this plugin's settings form.
        Add the same token as the <code>AZURE_DEVOPS_PAT</code> company secret so agents can clone Azure Repos.
      </p>
      {status.error ? <p role="alert">{status.error.message}</p> : null}
      <KeyValueList
        pairs={[
          { label: "Configured", value: data?.configured ? "Yes" : "No" },
          { label: "Scheduled sync", value: data?.syncEnabled ? `Every ${data.syncIntervalMinutes} min` : "Off" },
          { label: "Last board sync", value: data?.board?.lastSyncAt ?? "Never" },
          { label: "Last result", value: data?.board ? (data.board.error ?? `${data.board.created} created, ${data.board.updated} updated`) : "—" },
          { label: "Developer agents", value: data?.agents ? `${data.agents.agents.length} (${data.agents.teams.join(", ")})` : "Not synced" },
        ]}
      />
      <ActionBar
        actions={[
          { label: "Sync board now", actionKey: "sync-now", params: { companyId } },
          { label: "Sync team developer agents", actionKey: "sync-agents", params: { companyId } },
        ]}
        onSuccess={() => status.refresh()}
        onError={(_key, error) => {
          toast({ title: "Azure DevOps action failed", body: error instanceof Error ? error.message : String(error), tone: "error" });
          status.refresh();
        }}
      />
    </div>
  );
}
