/**
 * Built-in skills and MCP servers tenants can install, plus repository-based suggestions.
 * Installed copies live in the tenant's `skills` / `mcp_servers` tables and can be edited.
 */

export interface CatalogSkill {
  key: string;
  name: string;
  description: string;
  content: string;
  /** Repository root files that make this skill relevant. */
  signals: RegExp[];
}

export interface CatalogMcpServer {
  name: string;
  description: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envSecretNames: string[];
}

export const SKILL_CATALOG: CatalogSkill[] = [
  {
    key: "azure-work-item",
    name: "Azure work item workflow",
    description: "How to turn an Azure Boards work item into a reviewable change.",
    signals: [/.*/],
    content: `Read the work item description and acceptance criteria first.
Find the smallest change that satisfies them; do not refactor unrelated code.
Add or update tests that prove the acceptance criteria.
Run the repository's build and tests before finishing and report the results.
If the work item is ambiguous, implement the safest interpretation and state the assumption in your summary.`,
  },
  {
    key: "node-typescript",
    name: "Node.js / TypeScript",
    description: "Conventions for Node.js and TypeScript repositories.",
    signals: [/^package\.json$/, /^tsconfig.*\.json$/],
    content: `Use the package manager the lockfile implies (pnpm-lock.yaml → pnpm, yarn.lock → yarn, otherwise npm).
Install dependencies before running scripts. Prefer the scripts in package.json (test, lint, typecheck, build).
Keep strict typing; do not add \`any\` or disable lint rules to make a change compile.`,
  },
  {
    key: "dotnet",
    name: ".NET",
    description: "Conventions for C# / .NET solutions.",
    signals: [/\.sln$/, /\.csproj$/, /^global\.json$/, /^Directory\.Build\.props$/],
    content: `Build with \`dotnet build\` and test with \`dotnet test\` from the solution directory.
Follow the existing nullable settings and analyzers; fix warnings you introduce.
Use dependency injection and async APIs the way the surrounding code does.`,
  },
  {
    key: "python",
    name: "Python",
    description: "Conventions for Python projects.",
    signals: [/^pyproject\.toml$/, /^requirements.*\.txt$/, /^setup\.py$/, /^Pipfile$/],
    content: `Create or reuse a virtual environment; install from pyproject.toml or requirements files.
Run the configured test runner (pytest by default) and linters (ruff/flake8/mypy) if present.
Add type hints to new functions.`,
  },
  {
    key: "java",
    name: "Java / JVM",
    description: "Conventions for Maven and Gradle projects.",
    signals: [/^pom\.xml$/, /^build\.gradle(\.kts)?$/, /^settings\.gradle(\.kts)?$/],
    content: `Use the wrapper (./mvnw or ./gradlew) when present. Run the unit tests for touched modules.
Keep package structure and formatting consistent with neighbouring classes.`,
  },
  {
    key: "frontend",
    name: "Web frontend",
    description: "UI changes in React, Angular or Vue applications.",
    signals: [/^angular\.json$/, /^vite\.config\./, /^next\.config\./, /^vue\.config\./],
    content: `Reuse existing components and design tokens instead of adding new styles.
Keep components accessible (labels, keyboard focus, contrast).
Add or update component tests for changed behaviour.`,
  },
  {
    key: "security-review",
    name: "Security review",
    description: "Checks to run on every change before it is proposed.",
    signals: [/.*/],
    content: `Never commit secrets, tokens or connection strings; use configuration or the existing secret store.
Validate and encode untrusted input; use parameterized queries.
Do not weaken authentication, authorization or TLS settings.`,
  },
];

export const MCP_CATALOG: CatalogMcpServer[] = [
  {
    name: "azure-devops",
    description: "Microsoft's Azure DevOps MCP server: work items, repos, pipelines, wiki.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@azure-devops/mcp", "<organization>"],
    envSecretNames: ["AZURE_DEVOPS_PAT"],
  },
  {
    name: "playwright",
    description: "Browser automation for verifying web UI changes.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless"],
    envSecretNames: [],
  },
];

export interface SkillSuggestion {
  key: string;
  name: string;
  description: string;
  reason: string;
}

/** Suggests catalog skills not yet installed, based on repository root file names. */
export function suggestSkills(rootFilesByRepo: Record<string, string[]>, installedKeys: string[]): SkillSuggestion[] {
  const installed = new Set(installedKeys);
  const suggestions: SkillSuggestion[] = [];
  for (const skill of SKILL_CATALOG) {
    if (installed.has(skill.key)) continue;
    const universal = skill.signals.some((signal) => signal.source === ".*");
    const matchedRepos = Object.entries(rootFilesByRepo)
      .filter(([, files]) => files.some((file) => skill.signals.some((signal) => signal.test(file))))
      .map(([repo]) => repo);
    if (universal) {
      suggestions.push({ key: skill.key, name: skill.name, description: skill.description, reason: "Recommended for every agent" });
    } else if (matchedRepos.length > 0) {
      suggestions.push({ key: skill.key, name: skill.name, description: skill.description, reason: `Detected in ${matchedRepos.join(", ")}` });
    }
  }
  return suggestions;
}
