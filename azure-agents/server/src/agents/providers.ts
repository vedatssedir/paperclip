import path from "node:path";
import { SECRET } from "../secrets.js";

export type Provider = "claude" | "openai" | "gemini";

export interface ResolvedSkill {
  key: string;
  name: string;
  description: string;
  content: string;
}

export interface ResolvedMcpServer {
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
}

export interface ProviderInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Files written into the run directory (outside every repository checkout). */
  files: Array<{ path: string; content: string }>;
}

/** Secret holding each provider's API key. Claude can also use a logged-in CLI. */
export const PROVIDER_KEY_SECRET: Record<Provider, string> = {
  claude: SECRET.anthropicKey,
  openai: SECRET.openaiKey,
  gemini: SECRET.geminiKey,
};

function tomlString(value: string) {
  return JSON.stringify(value);
}

function skillMarkdown(skill: ResolvedSkill) {
  return `---\nname: ${skill.key}\ndescription: ${JSON.stringify(skill.description || skill.name)}\n---\n\n${skill.content.trim()}\n`;
}

/**
 * Builds the CLI invocation for one provider. Every CLI runs non-interactively in the run
 * directory, whose subfolders are the repository checkouts.
 */
export function buildInvocation(input: {
  provider: Provider;
  model: string | null;
  prompt: string;
  apiKey: string | null;
  runDir: string;
  skills: ResolvedSkill[];
  mcpServers: ResolvedMcpServer[];
}): ProviderInvocation {
  const files: ProviderInvocation["files"] = [];
  const env: Record<string, string> = {};

  if (input.provider === "claude") {
    for (const skill of input.skills) {
      files.push({ path: `.claude/skills/${skill.key}/SKILL.md`, content: skillMarkdown(skill) });
    }
    const args = ["-p", input.prompt, "--permission-mode", "acceptEdits", "--output-format", "text"];
    if (input.model) args.push("--model", input.model);
    if (input.mcpServers.length > 0) {
      const mcpServers = Object.fromEntries(input.mcpServers.map((server) => [server.name,
        server.transport === "http"
          ? { type: "http", url: server.url }
          : { command: server.command, args: server.args, env: server.env }]));
      files.push({ path: ".mcp.json", content: JSON.stringify({ mcpServers }, null, 2) });
      args.push("--mcp-config", path.join(input.runDir, ".mcp.json"));
    }
    if (input.apiKey) env.ANTHROPIC_API_KEY = input.apiKey;
    return { command: "claude", args, env, files };
  }

  // Codex and Gemini read skills as plain files referenced from the prompt.
  for (const skill of input.skills) files.push({ path: `.skills/${skill.key}.md`, content: skillMarkdown(skill) });
  const prompt = input.skills.length > 0
    ? `${input.prompt}\n\nBefore starting, read the skill files in ${path.join(input.runDir, ".skills")} and follow them.`
    : input.prompt;

  if (input.provider === "openai") {
    const args = ["exec", "--full-auto", "--skip-git-repo-check"];
    if (input.model) args.push("-m", input.model);
    for (const server of input.mcpServers) {
      const key = `mcp_servers.${server.name}`;
      if (server.transport === "http") {
        args.push("-c", `${key}.url=${tomlString(server.url!)}`);
      } else {
        args.push("-c", `${key}.command=${tomlString(server.command!)}`);
        args.push("-c", `${key}.args=[${server.args.map(tomlString).join(",")}]`);
        for (const [name, value] of Object.entries(server.env)) args.push("-c", `${key}.env.${name}=${tomlString(value)}`);
      }
    }
    args.push(prompt);
    if (input.apiKey) env.OPENAI_API_KEY = input.apiKey;
    return { command: "codex", args, env, files };
  }

  const args = ["-p", prompt, "--yolo"];
  if (input.model) args.push("-m", input.model);
  if (input.mcpServers.length > 0) {
    const mcpServers = Object.fromEntries(input.mcpServers.map((server) => [server.name,
      server.transport === "http"
        ? { httpUrl: server.url }
        : { command: server.command, args: server.args, env: server.env }]));
    files.push({ path: ".gemini/settings.json", content: JSON.stringify({ mcpServers }, null, 2) });
  }
  if (input.apiKey) env.GEMINI_API_KEY = input.apiKey;
  return { command: "gemini", args, env, files };
}

export function buildPrompt(input: {
  agentInstructions: string;
  workItem: { azureId: number; type: string; title: string; descriptionText: string; webUrl: string };
  repositories: Array<{ name: string; dir: string; branch: string }>;
}): string {
  const repoLines = input.repositories.map((repo) => `- ${repo.name}: ./${repo.dir} (branch ${repo.branch} is checked out)`);
  return [
    input.agentInstructions.trim(),
    "",
    `You are implementing Azure Boards ${input.workItem.type} #${input.workItem.azureId}: ${input.workItem.title}`,
    `Work item: ${input.workItem.webUrl}`,
    "",
    "Description:",
    input.workItem.descriptionText || "(no description)",
    "",
    "Repositories (each is a git checkout in the current directory):",
    ...repoLines,
    "",
    "Rules:",
    "- Change only these repositories. Do not switch branches, push, or open pull requests; the platform does that.",
    "- Keep changes focused on the work item, follow each repository's conventions, and run its tests when possible.",
    "- Finish with a short summary of what you changed and how you verified it.",
  ].filter((line, index, lines) => !(line === "" && lines[index - 1] === "")).join("\n").trim();
}
