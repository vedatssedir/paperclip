// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyPluginConfigSection } from "./CompanyPluginConfigSection";

const mockGet = vi.hoisted(() => vi.fn());
const mockGetConfig = vi.hoisted(() => vi.fn());

vi.mock("@/api/plugins", () => ({
  pluginsApi: { get: mockGet, getConfig: mockGetConfig },
}));

vi.mock("@/pages/PluginSettings", () => ({
  PluginConfigForm: (props: { pluginId: string; companyId: string; initialValues?: Record<string, unknown> }) => (
    <div data-testid="config-form">
      {props.pluginId}:{props.companyId}:{JSON.stringify(props.initialValues ?? null)}
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function render(container: HTMLDivElement) {
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CompanyPluginConfigSection pluginId="plugin-1" companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  return root;
}

describe("CompanyPluginConfigSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the host config form with saved company config", async () => {
    mockGet.mockResolvedValue({
      id: "plugin-1",
      status: "ready",
      manifestJson: { instanceConfigSchema: { type: "object", properties: { project: { type: "string" } } } },
    });
    mockGetConfig.mockResolvedValue({ configJson: { project: "Fabrikam" } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = await render(container);
    expect(container.querySelector('[data-testid="config-form"]')?.textContent).toBe(
      'plugin-1:company-1:{"project":"Fabrikam"}',
    );
    expect(mockGetConfig).toHaveBeenCalledWith("plugin-1", "company-1");
    await act(async () => root.unmount());
  });

  it("renders nothing when the plugin declares no config schema", async () => {
    mockGet.mockResolvedValue({ id: "plugin-1", status: "ready", manifestJson: {} });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = await render(container);
    expect(container.innerHTML).toBe("");
    expect(mockGetConfig).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
