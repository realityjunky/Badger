#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import os from "node:os";
import {
  previewInstall,
  previewUninstall,
  commitHostPlan,
  shellCommand,
  type AgentHost,
  type InstallScope,
  type McpProfile,
} from "./index.js";
import { saveHostPlan, readHostPlan, removeHostPlan } from "./plans.js";
import { downloadPublishedPackage } from "./publication.js";
const help = `badger-hosts preview-install --url URL --workflow ID --publication ID --package-hash SHA256 --host claude|codex|workbuddy --scope project|user [--project DIR] [--home DIR] [--command EXECUTABLE] [--arg VALUE ...] [--profile operator|auto|engineer|expert]
badger-hosts preview-uninstall --workflow ID --host HOST --scope SCOPE [--project DIR] [--home DIR]
badger-hosts commit --plan FILE --digest SHA256 --confirm

Set BADGER_TOKEN in the local environment. Preview never installs. Review every operation, then confirm the exact digest. The local MCP executable must already be available.\n`;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      workflow: { type: "string" },
      publication: { type: "string" },
      "package-hash": { type: "string" },
      host: { type: "string" },
      scope: { type: "string" },
      project: { type: "string" },
      home: { type: "string" },
      command: { type: "string" },
      arg: { type: "string", multiple: true },
      profile: { type: "string" },
      plan: { type: "string" },
      digest: { type: "string" },
      confirm: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  function required(name: keyof typeof values): string {
    const value = values[name];
    if (typeof value !== "string" || !value)
      throw new Error(`Supply --${name}`);
    return value;
  }
  const action = positionals[0];
  if (values.help || action === undefined) process.stdout.write(help);
  else if (positionals.length !== 1)
    throw new Error("Choose one host installer action");
  else if (action === "commit") {
    if (values.confirm !== true)
      throw new Error(
        "Review the preview and pass --confirm to confirm its digest",
      );
    const file = required("plan");
    const plan = await readHostPlan(file);
    const result = await commitHostPlan(plan, {
      confirmed: true,
      digest: required("digest"),
    });
    await removeHostPlan(file);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (action === "preview-install" || action === "preview-uninstall") {
    if (values.confirm)
      throw new Error("Preview first; commit is a separate action");
    const target = {
      host: required("host") as AgentHost,
      scope: required("scope") as InstallScope,
      projectRoot: path.resolve(values.project ?? process.cwd()),
      homeRoot: path.resolve(values.home ?? os.homedir()),
    };
    const workflowId = required("workflow");
    let plan;
    if (action === "preview-install") {
      const publication = {
        workflowId,
        publicationId: required("publication"),
        packageHash: required("package-hash"),
      };
      const url = required("url");
      const snapshot = await downloadPublishedPackage(
        { url, token: process.env["BADGER_TOKEN"] ?? "" },
        publication,
      );
      plan = await previewInstall({
        target,
        publication,
        snapshot,
        deploymentUrl: url,
        ...(process.platform === "win32" && !values.command
          ? { platform: "win32" as const }
          : {}),
        ...(values.command ? { command: values.command } : {}),
        ...(values.arg ? { args: values.arg } : {}),
        ...(values.profile ? { profile: values.profile as McpProfile } : {}),
      });
    } else plan = await previewUninstall({ target, workflowId });
    const planFile = await saveHostPlan(plan);
    const commitArgs = [
      "badger-hosts",
      "commit",
      "--plan",
      planFile,
      "--digest",
      plan.preview.digest,
      "--confirm",
    ];
    const commitCommand = shellCommand(
      commitArgs,
      process.platform === "win32" ? "powershell" : "posix",
    );
    process.stdout.write(
      JSON.stringify(
        {
          preview: plan.preview,
          planFile,
          commitCommand,
          commitCommands: {
            posix: shellCommand(commitArgs),
            powershell: shellCommand(commitArgs, "powershell"),
          },
          message:
            "Review every local operation, then confirm this digest. Set BADGER_TOKEN in the environment that starts your host. Sign-offs stay in the dashboard.",
        },
        null,
        2,
      ) + "\n",
    );
  } else
    throw new Error("Choose preview-install, preview-uninstall, or commit");
} catch (error) {
  const token = process.env["BADGER_TOKEN"];
  const message =
    error instanceof Error ? error.message : "Host operation failed";
  process.stderr.write(
    `Badger hosts: ${token ? message.replaceAll(token, "[redacted]") : message}\n`,
  );
  process.exitCode = 1;
}
