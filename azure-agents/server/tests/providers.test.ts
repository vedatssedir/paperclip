import { describe, expect, it } from "vitest";
import { buildInvocation } from "../src/agents/providers.js";
import { branchName, reconciliationQuery, toWorkItemRow } from "../src/azure/mapping.js";
import { retryDelayMs } from "../src/azure/client.js";
import { suggestSkills } from "../src/agents/catalog.js";

const skills = [{ key: "dotnet", name: ".NET", description: "d", content: "Use dotnet test." }];
const mcpServers = [{ name: "ado", transport: "stdio" as const, command: "npx", args: ["-y", "@azure-devops/mcp", "acme"], url: null, env: { AZURE_DEVOPS_PAT: "p" } }];

describe("provider invocations", () => {
  it("runs Claude CLI with project skills and an MCP config file", () => {
    const inv = buildInvocation({ provider: "claude", model: "sonnet", prompt: "do it", apiKey: "sk-ant", runDir: "/w", skills, mcpServers });
    expect(inv.command).toBe("claude");
    expect(inv.args).toEqual(["-p", "do it", "--permission-mode", "acceptEdits", "--output-format", "text", "--model", "sonnet", "--mcp-config", "/w/.mcp.json"]);
    expect(inv.files.map((f) => f.path)).toEqual([".claude/skills/dotnet/SKILL.md", ".mcp.json"]);
    expect(inv.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant" });
  });

  it("runs Codex CLI with the OpenAI key and MCP servers as config overrides", () => {
    const inv = buildInvocation({ provider: "openai", model: "gpt-5-codex", prompt: "do it", apiKey: "sk-oa", runDir: "/w", skills, mcpServers });
    expect(inv.command).toBe("codex");
    expect(inv.args.slice(0, 5)).toEqual(["exec", "--full-auto", "--skip-git-repo-check", "-m", "gpt-5-codex"]);
    expect(inv.args).toContain('mcp_servers.ado.args=["-y","@azure-devops/mcp","acme"]');
    expect(inv.args.at(-1)).toContain("/w/.skills");
    expect(inv.env).toEqual({ OPENAI_API_KEY: "sk-oa" });
  });

  it("runs Gemini CLI with the Gemini key and a workspace settings file", () => {
    const inv = buildInvocation({ provider: "gemini", model: null, prompt: "do it", apiKey: "g-key", runDir: "/w", skills: [], mcpServers });
    expect(inv.command).toBe("gemini");
    expect(inv.args).toEqual(["-p", "do it", "--yolo"]);
    expect(JSON.parse(inv.files[0]!.content).mcpServers.ado.command).toBe("npx");
    expect(inv.env).toEqual({ GEMINI_API_KEY: "g-key" });
  });
});

describe("azure mapping", () => {
  it("maps work items and repo tags", () => {
    const row = toWorkItemRow({ id: 7, rev: 3, fields: { "System.Title": "Fix", "System.Tags": "repo:api; repo:Web; ui",
      "System.AssignedTo": { displayName: "Jane", uniqueName: "Jane@Acme.com" }, "Microsoft.VSTS.Common.Priority": 2 } });
    expect(row).toMatchObject({ repoNames: ["api", "Web"], assignedToUniqueName: "jane@acme.com", priority: 2, state: "New" });
  });

  it("builds branch names and reconciliation queries", () => {
    expect(branchName(42, "Çok önemli: Login düzelt!")).toBe("ab/42-cok-onemli-login-duzelt");
    expect(reconciliationQuery(new Date("2026-10-20T10:00:00Z"))).toContain("[System.ChangedDate] >= '2026-10-20'");
    expect(reconciliationQuery(null)).toContain("@today - 90");
  });

  it("backs off on throttling", () => {
    expect(retryDelayMs(0, "2")).toBe(2000);
    expect(retryDelayMs(2, null)).toBe(2000);
    expect(retryDelayMs(0, "999")).toBe(30_000);
  });

  it("suggests skills from repository files", () => {
    const suggestions = suggestSkills({ api: ["package.json"], svc: ["Svc.sln"] }, ["security-review"]);
    expect(suggestions.map((s) => s.key)).toEqual(["azure-work-item", "node-typescript", "dotnet"]);
  });
});
