import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  localInstallCommand,
  localUninstallCommand,
  renderMcpConfiguration,
} from "../src/configuration.js";

const input = {
  deploymentUrl: "https://badger.example/team",
  workflowId: "workflow's $name",
  publicationId: "publication",
  packageHash: "a".repeat(64),
  host: "codex" as const,
  scope: "project" as const,
  mcpCliPath: "C:\\Agent's tools\\badger-mcp\\cli.js",
};
let pwsh = false;
try {
  execFileSync(
    "pwsh",
    ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    { stdio: "ignore" },
  );
  pwsh = true;
} catch {
  /* Optional platform executable. */
}

it("renders executable PowerShell commands with literal arguments and node for Windows", () => {
  expect(localInstallCommand({ ...input, shell: "powershell" })).toContain(
    "& 'badger-hosts'",
  );
  expect(localInstallCommand({ ...input, shell: "powershell" })).toContain(
    "'--command' 'node' '--arg' 'C:\\Agent''s tools\\badger-mcp\\cli.js'",
  );
  expect(localUninstallCommand({ ...input, shell: "powershell" })).toContain(
    "'workflow''s $name'",
  );
  expect(
    JSON.parse(
      renderMcpConfiguration("claude", {
        deploymentUrl: input.deploymentUrl,
        platform: "win32",
        mcpCliPath: input.mcpCliPath,
      }),
    ).mcpServers.badger,
  ).toMatchObject({ command: "node", args: [input.mcpCliPath] });
});

it.skipIf(!pwsh)(
  "executes install and uninstall PowerShell forms without expanding quoted arguments",
  () => {
    for (const command of [
      localInstallCommand({ ...input, shell: "powershell" }),
      localUninstallCommand({ ...input, shell: "powershell" }),
    ]) {
      const output = execFileSync(
        "pwsh",
        [
          "-NoProfile",
          "-Command",
          `function badger-hosts { ConvertTo-Json -InputObject @($args) -Compress }; ${command}`,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(output)).toContain(input.workflowId);
    }
  },
);
