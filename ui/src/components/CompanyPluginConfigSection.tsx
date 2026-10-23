import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "@/api/plugins";
import type { JsonSchemaNode } from "@/components/JsonSchemaForm";
import { queryKeys } from "@/lib/queryKeys";
import { PluginConfigForm } from "@/pages/PluginSettings";

/**
 * Renders the host's auto-generated `instanceConfigSchema` form for a plugin
 * inside its company settings page, so operators can edit the plugin config
 * next to the plugin's own company settings UI. Renders nothing when the
 * plugin declares no config schema.
 */
export function CompanyPluginConfigSection({ pluginId, companyId }: { pluginId: string; companyId: string }) {
  const { data: plugin } = useQuery({
    queryKey: queryKeys.plugins.detail(pluginId),
    queryFn: () => pluginsApi.get(pluginId),
  });
  const schema = plugin?.manifestJson?.instanceConfigSchema as JsonSchemaNode | undefined;
  const hasSchema = Boolean(schema?.properties && Object.keys(schema.properties).length > 0);

  const { data: config, isLoading } = useQuery({
    queryKey: queryKeys.plugins.config(pluginId, companyId),
    queryFn: () => pluginsApi.getConfig(pluginId, companyId),
    enabled: hasSchema,
  });

  if (!schema || !hasSchema) return null;

  return (
    <section className="space-y-3" aria-label="Plugin configuration">
      <h2 className="text-sm font-semibold">Configuration</h2>
      <PluginConfigForm
        pluginId={pluginId}
        companyId={companyId}
        schema={schema}
        initialValues={config?.configJson}
        isLoading={isLoading}
        pluginStatus={plugin?.status}
        supportsConfigTest={(plugin as unknown as { supportsConfigTest?: boolean }).supportsConfigTest === true}
      />
    </section>
  );
}
