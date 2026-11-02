/** Browser-safe host configuration shared by the dashboard and local adapter. */
export type AgentHost = "claude" | "codex" | "workbuddy";
export type InstallScope = "project" | "user";
export type McpProfile = "auto" | "engineer" | "expert" | "operator";
export type CommandShell = "posix" | "powershell";
export interface McpConfiguration {
  deploymentUrl: string;
  command?: string;
  args?: string[];
  profile?: McpProfile;
  platform?: "posix" | "win32";
  mcpCliPath?: string;
}

export function deploymentUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Set an absolute Badger deployment URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Use an HTTPS deployment URL or loopback HTTP without credentials, query, or fragment",
    );
  return url.href.replace(/\/+$/u, "");
}

export function mcpEntry(host: AgentHost, options: McpConfiguration) {
  if (!["claude", "codex", "workbuddy"].includes(host))
    throw new Error("Select a supported Agent host");
  const windows = options.platform === "win32";
  if (windows && !options.command && !options.mcpCliPath?.trim())
    throw new Error("Set the installed Badger MCP cli.js path for Windows");
  const command = options.command ?? (windows ? "node" : "badger-mcp");
  const args =
    options.args ?? (windows && options.mcpCliPath ? [options.mcpCliPath] : []);
  const profile = options.profile ?? "operator";
  if (!command.trim() || /[\u0000-\u001f\u007f]/u.test(command))
    throw new Error("Set an MCP executable without control characters");
  if (
    !Array.isArray(args) ||
    args.some(
      (arg) => typeof arg !== "string" || /[\u0000-\u001f\u007f]/u.test(arg),
    )
  )
    throw new Error("Set MCP arguments without control characters");
  if (!["auto", "engineer", "expert", "operator"].includes(profile))
    throw new Error("Select a supported MCP profile");
  return {
    ...(host === "codex" ? {} : { type: "stdio" }),
    command,
    args: [...args],
    ...(host === "codex" ? { env_vars: ["BADGER_TOKEN"] } : {}),
    env: {
      BADGER_URL: deploymentUrl(options.deploymentUrl),
      BADGER_MCP_PROFILE: profile,
      ...(host === "codex" ? {} : { BADGER_TOKEN: "${BADGER_TOKEN}" }),
    },
  };
}

export function renderMcpConfiguration(
  host: AgentHost,
  options: McpConfiguration,
): string {
  const entry = mcpEntry(host, options);
  if (host !== "codex")
    return JSON.stringify({ mcpServers: { badger: entry } }, null, 2) + "\n";
  return `[mcp_servers.badger]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\nenv_vars = ["BADGER_TOKEN"]\n\n[mcp_servers.badger.env]\nBADGER_URL = ${JSON.stringify(entry.env.BADGER_URL)}\nBADGER_MCP_PROFILE = ${JSON.stringify(entry.env.BADGER_MCP_PROFILE)}\n`;
}

export function hostPaths(host: AgentHost, scope: InstallScope) {
  if (!["project", "user"].includes(scope))
    throw new Error("Select project or user scope");
  switch (host) {
    case "claude":
      return {
        skills: ".claude/skills",
        configuration: scope === "project" ? ".mcp.json" : ".claude.json",
      };
    case "codex":
      return { skills: ".agents/skills", configuration: ".codex/config.toml" };
    case "workbuddy":
      return {
        skills: ".codebuddy/skills",
        configuration:
          scope === "project" ? ".mcp.json" : ".codebuddy/.mcp.json",
      };
    default:
      throw new Error("Select a supported Agent host");
  }
}

export function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function shellCommand(
  args: readonly string[],
  shell: CommandShell = "posix",
): string {
  return shell === "powershell"
    ? `& ${args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")}`
    : args.map(shellArgument).join(" ");
}
export function localInstallCommand(input: {
  deploymentUrl: string;
  workflowId: string;
  publicationId: string;
  packageHash: string;
  host: AgentHost;
  scope: InstallScope;
  shell?: CommandShell;
  mcpCliPath?: string;
}): string {
  const args = [
    "badger-hosts",
    "preview-install",
    "--url",
    deploymentUrl(input.deploymentUrl),
    "--workflow",
    input.workflowId,
    "--publication",
    input.publicationId,
    "--package-hash",
    input.packageHash,
    "--host",
    input.host,
    "--scope",
    input.scope,
  ];
  if (input.shell === "powershell") {
    if (!input.mcpCliPath?.trim())
      throw new Error("Set the installed Badger MCP cli.js path for Windows");
    args.push("--command", "node", "--arg", input.mcpCliPath);
  }
  return shellCommand(args, input.shell);
}
export function localUninstallCommand(input: {
  workflowId: string;
  host: AgentHost;
  scope: InstallScope;
  shell?: CommandShell;
}): string {
  return shellCommand(
    [
      "badger-hosts",
      "preview-uninstall",
      "--workflow",
      input.workflowId,
      "--host",
      input.host,
      "--scope",
      input.scope,
    ],
    input.shell,
  );
}
