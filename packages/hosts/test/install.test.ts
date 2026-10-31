import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPackageSnapshot, hashDirectory } from "@realityjunky/badger";
import {
  previewInstall,
  previewUninstall,
  commitHostPlan,
  type HostPlan,
} from "../src/index.js";
import { parse as parseToml } from "smol-toml";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0))
    await fs.rm(folder, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-hosts-test-"));
  folders.push(root);
  const projectRoot = path.join(root, "project");
  const homeRoot = path.join(root, "home");
  const published = path.join(root, "published");
  await Promise.all([projectRoot, homeRoot, published].map((p) => fs.mkdir(p)));
  const text =
    "---\nname: example\ndescription: A published example.\n---\n\n# Example\n";
  await fs.writeFile(path.join(published, "SKILL.md"), text);
  const snapshot = await createPackageSnapshot(published, [
    {
      path: "SKILL.md",
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
      owner: "auto",
    },
  ]);
  return {
    projectRoot,
    homeRoot,
    snapshot,
    publication: {
      workflowId: "workflow-1",
      publicationId: "publication-1",
      packageHash: snapshot.packageHash,
    },
  };
}

it("previews and confirms exact published bytes and environment-based MCP configuration, then uninstalls only its own files", async () => {
  const f = await fixture();
  const target = {
    host: "claude" as const,
    scope: "project" as const,
    projectRoot: f.projectRoot,
    homeRoot: f.homeRoot,
  };
  await fs.writeFile(
    path.join(f.projectRoot, ".mcp.json"),
    '{"theme":"dark","mcpServers":{"other":{"command":"other"}}}\n',
  );
  const plan = await previewInstall({
    target,
    publication: f.publication,
    snapshot: f.snapshot,
    deploymentUrl: "https://badger.example/team",
  });
  expect(plan.preview.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "write",
        path: path.join(f.projectRoot, ".mcp.json"),
        expectedHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]),
  );
  await expect(
    fs.stat(path.join(f.projectRoot, ".claude/skills/badger-workflow-1")),
  ).rejects.toThrow();
  await expect(
    commitHostPlan(plan, { digest: plan.preview.digest, confirmed: false }),
  ).rejects.toThrow(/confirm/iu);
  await commitHostPlan(plan, { digest: plan.preview.digest, confirmed: true });
  expect(
    await hashDirectory(
      path.join(f.projectRoot, ".claude/skills/badger-workflow-1"),
    ),
  ).toBe(f.snapshot.packageHash);
  const config = JSON.parse(
    await fs.readFile(path.join(f.projectRoot, ".mcp.json"), "utf8"),
  );
  expect(config).toMatchObject({
    theme: "dark",
    mcpServers: {
      other: { command: "other" },
      badger: {
        command: "badger-mcp",
        env: {
          BADGER_URL: "https://badger.example/team",
          BADGER_TOKEN: "${BADGER_TOKEN}",
          BADGER_MCP_PROFILE: "operator",
        },
      },
    },
  });
  const uninstall = await previewUninstall({
    target,
    workflowId: f.publication.workflowId,
  });
  await commitHostPlan(uninstall, {
    digest: uninstall.preview.digest,
    confirmed: true,
  });
  expect(
    JSON.parse(
      await fs.readFile(path.join(f.projectRoot, ".mcp.json"), "utf8"),
    ),
  ).toEqual({ theme: "dark", mcpServers: { other: { command: "other" } } });
  await expect(
    fs.stat(path.join(f.projectRoot, ".claude/skills/badger-workflow-1")),
  ).rejects.toThrow();
});

it.each([
  ["claude", "project", ".claude/skills", ".mcp.json"],
  ["claude", "user", ".claude/skills", ".claude.json"],
  ["codex", "project", ".agents/skills", ".codex/config.toml"],
  ["codex", "user", ".agents/skills", ".codex/config.toml"],
  ["workbuddy", "project", ".codebuddy/skills", ".mcp.json"],
  ["workbuddy", "user", ".codebuddy/skills", ".codebuddy/.mcp.json"],
] as const)(
  "installs and uninstalls %s at %s scope while preserving unrelated configuration",
  async (host, scope, skills, configuration) => {
    const f = await fixture();
    const target = {
      host,
      scope,
      projectRoot: f.projectRoot,
      homeRoot: f.homeRoot,
    };
    const root = scope === "project" ? f.projectRoot : f.homeRoot;
    const file = path.join(root, configuration);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const unrelated =
      host === "codex"
        ? '# Personal settings\nmodel = "example"\n[mcp_servers.other]\ncommand = "other"\n'
        : '{"theme":"dark","mcpServers":{"other":{"command":"other"}},"private":"DO_NOT_DISPLAY"}\n';
    await fs.writeFile(file, unrelated);
    const plan = await previewInstall({
      target,
      publication: f.publication,
      snapshot: f.snapshot,
      deploymentUrl: "https://badger.example/team",
      command: '/opt/Agent Tools/"badger"',
      args: ["C:\\Badger Tools\\运行\\cli.js", "literal $value `text`"],
    });
    expect(JSON.stringify(plan.preview)).not.toContain("DO_NOT_DISPLAY");
    expect(plan.preview.packageDirectory).toBe(
      path.join(root, skills, "badger-workflow-1"),
    );
    await commitHostPlan(plan, {
      confirmed: true,
      digest: plan.preview.digest,
    });
    const content = await fs.readFile(file, "utf8");
    const doc = host === "codex" ? parseToml(content) : JSON.parse(content);
    const entry =
      host === "codex" ? doc.mcp_servers.badger : doc.mcpServers.badger;
    expect(entry.args).toEqual([
      "C:\\Badger Tools\\运行\\cli.js",
      "literal $value `text`",
    ]);
    if (host === "codex") {
      expect(doc.mcp_servers.badger.env_vars).toEqual(["BADGER_TOKEN"]);
      expect(doc.mcp_servers.badger.env).not.toHaveProperty("BADGER_TOKEN");
      expect(content.startsWith(unrelated)).toBe(true);
    } else
      expect(doc.mcpServers.badger.env.BADGER_TOKEN).toBe("${BADGER_TOKEN}");
    const uninstall = await previewUninstall({
      target,
      workflowId: f.publication.workflowId,
    });
    const removedConfiguration =
      host === "codex"
        ? parseToml(uninstall.preview.configuration).mcp_servers
        : JSON.parse(uninstall.preview.configuration).mcpServers;
    expect(removedConfiguration.badger.args).toEqual(entry.args);
    expect(
      uninstall.preview.operations
        .filter((op) => op.action === "delete")
        .every((op) => op.expectedHash?.length === 64),
    ).toBe(true);
    await commitHostPlan(uninstall, {
      confirmed: true,
      digest: uninstall.preview.digest,
    });
    const remaining = await fs.readFile(file, "utf8");
    if (host === "codex") expect(remaining).toBe(unrelated);
    else expect(JSON.parse(remaining)).toEqual(JSON.parse(unrelated));
    expect(
      await fs.readdir(scope === "project" ? f.homeRoot : f.projectRoot),
    ).toEqual([]);
  },
);

it.skipIf(process.platform === "win32").each([
  ["claude", ".claude.json"],
  ["codex", ".codex/config.toml"],
  ["workbuddy", ".codebuddy/.mcp.json"],
] as const)(
  "keeps a private %s configuration file private through install and uninstall",
  async (host, configuration) => {
    const f = await fixture();
    const target = {
      host,
      scope: "user" as const,
      projectRoot: f.projectRoot,
      homeRoot: f.homeRoot,
    };
    const file = path.join(f.homeRoot, configuration);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      host === "codex"
        ? '[mcp_servers.other.env]\nTOKEN = "literal"\n'
        : '{"mcpServers":{"other":{"command":"other","env":{"TOKEN":"literal"}}}}\n',
    );
    await fs.chmod(file, 0o600);
    const plan = await previewInstall({
      target,
      publication: f.publication,
      snapshot: f.snapshot,
      deploymentUrl: "https://badger.example",
    });
    await commitHostPlan(plan, {
      confirmed: true,
      digest: plan.preview.digest,
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const uninstall = await previewUninstall({
      target,
      workflowId: f.publication.workflowId,
    });
    await commitHostPlan(uninstall, {
      confirmed: true,
      digest: uninstall.preview.digest,
    });
    expect(await fs.readFile(file, "utf8")).toContain("literal");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  },
);

it("refuses changed previews, unowned and modified files, and tampered published bytes before any write", async () => {
  const f = await fixture();
  const target = {
    host: "codex" as const,
    scope: "project" as const,
    projectRoot: f.projectRoot,
    homeRoot: f.homeRoot,
  };
  const input = {
    target,
    publication: f.publication,
    snapshot: f.snapshot,
    deploymentUrl: "https://badger.example",
  };
  const plan = await previewInstall(input);
  await expect(
    commitHostPlan(plan, { confirmed: true, digest: "0".repeat(64) }),
  ).rejects.toThrow(/digest/iu);
  await fs.mkdir(path.join(f.projectRoot, ".codex"));
  await fs.writeFile(
    path.join(f.projectRoot, ".codex/config.toml"),
    'model = "changed"\n',
  );
  await expect(
    commitHostPlan(plan, { confirmed: true, digest: plan.preview.digest }),
  ).rejects.toThrow(/stale/iu);
  await expect(fs.stat(plan.preview.packageDirectory)).rejects.toThrow();
  const tampered = structuredClone(input);
  tampered.snapshot.files[0].content =
    Buffer.from("tampered").toString("base64");
  await expect(previewInstall(tampered)).rejects.toThrow(
    /snapshot|inventory/iu,
  );
  const fresh = await previewInstall(input);
  await commitHostPlan(fresh, {
    confirmed: true,
    digest: fresh.preview.digest,
  });
  const uninstall = await previewUninstall({
    target,
    workflowId: "workflow-1",
  });
  await fs.writeFile(
    path.join(fresh.preview.packageDirectory, "user.txt"),
    "My file",
  );
  await expect(
    commitHostPlan(uninstall, {
      confirmed: true,
      digest: uninstall.preview.digest,
    }),
  ).rejects.toThrow(/modified|unowned/iu);
  expect(
    await fs.readFile(
      path.join(fresh.preview.packageDirectory, "user.txt"),
      "utf8",
    ),
  ).toBe("My file");
  await fs.unlink(path.join(fresh.preview.packageDirectory, "user.txt"));
  await fs.writeFile(
    path.join(fresh.preview.packageDirectory, "SKILL.md"),
    "Edited",
  );
  await expect(
    previewUninstall({ target, workflowId: "workflow-1" }),
  ).rejects.toThrow(/modified/iu);
});

it("refuses unowned same-name MCP entries, symlink escapes, and unsafe package paths", async () => {
  const f = await fixture();
  const target = {
    host: "claude" as const,
    scope: "project" as const,
    projectRoot: f.projectRoot,
    homeRoot: f.homeRoot,
  };
  const input = {
    target,
    publication: f.publication,
    snapshot: f.snapshot,
    deploymentUrl: "https://badger.example",
  };
  const config = path.join(f.projectRoot, ".mcp.json");
  await fs.writeFile(
    config,
    '{"mcpServers":{"badger":{"command":"personal"}}}',
  );
  await expect(previewInstall(input)).rejects.toThrow(/unowned/iu);
  expect(await fs.readFile(config, "utf8")).toContain("personal");
  await fs.unlink(config);
  await fs.symlink(f.homeRoot, path.join(f.projectRoot, ".claude"), "dir");
  await expect(previewInstall(input)).rejects.toThrow(/symbolic/iu);
  expect(await fs.readdir(f.homeRoot)).toEqual([]);
  await fs.unlink(path.join(f.projectRoot, ".claude"));
  const unsafe = structuredClone(input);
  unsafe.snapshot.files[0].path = "../../escape";
  await expect(previewInstall(unsafe)).rejects.toThrow();
  const plan = await previewInstall(input);
  await fs.symlink(f.homeRoot, path.join(f.projectRoot, ".claude"), "dir");
  await expect(
    commitHostPlan(plan, { confirmed: true, digest: plan.preview.digest }),
  ).rejects.toThrow(/symbolic/iu);
  expect(await fs.readdir(f.homeRoot)).toEqual([]);
});

it.each([
  ["claude", "workbuddy", "Claude Code", "WorkBuddy"],
  ["workbuddy", "claude", "WorkBuddy", "Claude Code"],
] as const)(
  "lets one host at a time manage the shared project .mcp.json entry: %s, then %s",
  async (first, second, firstName, secondName) => {
    const f = await fixture();
    const config = path.join(f.projectRoot, ".mcp.json");
    const unrelated = '{"mcpServers":{"other":{"command":"other"}}}\n';
    await fs.writeFile(config, unrelated);
    const target = (host: typeof first | typeof second) => ({
      host,
      scope: "project" as const,
      projectRoot: f.projectRoot,
      homeRoot: f.homeRoot,
    });
    const install = (host: typeof first | typeof second) =>
      previewInstall({
        target: target(host),
        publication: f.publication,
        snapshot: f.snapshot,
        deploymentUrl: "https://badger.example",
      });
    const uninstall = (host: typeof first | typeof second) =>
      previewUninstall({ target: target(host), workflowId: "workflow-1" });
    const commit = (plan: HostPlan) =>
      commitHostPlan(plan, { confirmed: true, digest: plan.preview.digest });

    await commit(await install(first));
    const managed = await fs.readFile(config, "utf8");
    const refusal = (await install(second).catch((error) => error)) as Error;
    expect(refusal.message).toContain(
      `${firstName} manages the Badger MCP entry in .mcp.json`,
    );
    expect(refusal.message).toMatch(
      /uninstall .* there first or use user scope/u,
    );
    expect(refusal.message).not.toMatch(/remove/iu);
    // Removing the entry by hand does not hand it to the other host.
    const edited = JSON.parse(managed);
    delete edited.mcpServers.badger;
    await fs.writeFile(config, JSON.stringify(edited) + "\n");
    await expect(install(second)).rejects.toThrow(`${firstName} manages`);
    await fs.writeFile(config, managed);

    await commit(await uninstall(first));
    await commit(await install(second));
    await expect(install(first)).rejects.toThrow(`${secondName} manages`);
    await commit(await uninstall(second));
    expect(JSON.parse(await fs.readFile(config, "utf8"))).toEqual(
      JSON.parse(unrelated),
    );
  },
);

it("serializes commits for every host at a selected root with one lock", async () => {
  const f = await fixture();
  const [claude, workbuddy] = await Promise.all(
    (["claude", "workbuddy"] as const).map((host) =>
      previewInstall({
        target: {
          host,
          scope: "project",
          projectRoot: f.projectRoot,
          homeRoot: f.homeRoot,
        },
        publication: f.publication,
        snapshot: f.snapshot,
        deploymentUrl: "https://badger.example",
      }),
    ),
  );
  const lock = path.join(f.projectRoot, ".badger-install.lock");
  await fs.writeFile(lock, "");
  for (const plan of [claude, workbuddy])
    await expect(
      commitHostPlan(plan, { confirmed: true, digest: plan.preview.digest }),
    ).rejects.toThrow(/installation is active/iu);
  expect(await fs.readdir(f.projectRoot)).toEqual([".badger-install.lock"]);
  await fs.unlink(lock);
  await commitHostPlan(claude, {
    confirmed: true,
    digest: claude.preview.digest,
  });
  // The second commit recalculates its preview under the lock and finds the
  // entry the first one now manages.
  await expect(
    commitHostPlan(workbuddy, {
      confirmed: true,
      digest: workbuddy.preview.digest,
    }),
  ).rejects.toThrow(/Claude Code manages/u);
  expect(await fs.readdir(path.join(f.projectRoot, ".badger/hosts"))).toEqual([
    "claude.json",
  ]);
});

it("binds the selected root directory identity so a replacement home or project cannot inherit confirmation", async () => {
  const f = await fixture();
  const target = {
    host: "claude" as const,
    scope: "project" as const,
    projectRoot: f.projectRoot,
    homeRoot: f.homeRoot,
  };
  const plan = await previewInstall({
    target,
    publication: f.publication,
    snapshot: f.snapshot,
    deploymentUrl: "https://badger.example",
  });
  await fs.rename(f.projectRoot, `${f.projectRoot}-before`);
  await fs.mkdir(f.projectRoot);
  await expect(
    commitHostPlan(plan, { confirmed: true, digest: plan.preview.digest }),
  ).rejects.toThrow(/stale|changed/iu);
  expect(await fs.readdir(f.projectRoot)).toEqual([]);
});

it("retains shared MCP ownership until the last package and verifies owned bytes before an upgrade", async () => {
  const f = await fixture();
  const target = {
    host: "codex" as const,
    scope: "user" as const,
    projectRoot: f.projectRoot,
    homeRoot: f.homeRoot,
  };
  const first = {
    target,
    publication: f.publication,
    snapshot: f.snapshot,
    deploymentUrl: "https://badger.example",
  };
  for (const input of [
    first,
    { ...first, publication: { ...f.publication, workflowId: "workflow-2" } },
  ]) {
    const plan = await previewInstall(input);
    await commitHostPlan(plan, {
      confirmed: true,
      digest: plan.preview.digest,
    });
  }
  const removal = await previewUninstall({ target, workflowId: "workflow-1" });
  await commitHostPlan(removal, {
    confirmed: true,
    digest: removal.preview.digest,
  });
  expect(
    await fs.readFile(path.join(f.homeRoot, ".codex/config.toml"), "utf8"),
  ).toContain("[mcp_servers.badger]");
  expect(
    await hashDirectory(
      path.join(f.homeRoot, ".agents/skills/badger-workflow-2"),
    ),
  ).toBe(f.snapshot.packageHash);
  const replacement = await fixture();
  const updatedText =
    "---\nname: updated\ndescription: Updated publication.\n---\n# Updated\n";
  const published = path.join(path.dirname(replacement.homeRoot), "published");
  await fs.writeFile(path.join(published, "SKILL.md"), updatedText);
  const snapshot = await createPackageSnapshot(published, [
    {
      path: "SKILL.md",
      bytes: Buffer.byteLength(updatedText),
      sha256: createHash("sha256").update(updatedText).digest("hex"),
      owner: "auto",
    },
  ]);
  const upgrade = await previewInstall({
    ...first,
    snapshot,
    publication: {
      workflowId: "workflow-2",
      publicationId: "publication-2",
      packageHash: snapshot.packageHash,
    },
  });
  await commitHostPlan(upgrade, {
    confirmed: true,
    digest: upgrade.preview.digest,
  });
  expect(
    await hashDirectory(
      path.join(f.homeRoot, ".agents/skills/badger-workflow-2"),
    ),
  ).toBe(snapshot.packageHash);
  await fs.writeFile(
    path.join(f.homeRoot, ".codex/config.toml"),
    '[mcp_servers.badger]\ncommand = "personal"\n',
  );
  await expect(
    previewUninstall({ target, workflowId: "workflow-2" }),
  ).rejects.toThrow(/modified/iu);
});

it("refuses malformed host configuration without displaying pre-existing secret values", async () => {
  const f = await fixture();
  const target = {
    host: "codex" as const,
    scope: "user" as const,
    projectRoot: f.projectRoot,
    homeRoot: f.homeRoot,
  };
  await fs.mkdir(path.join(f.homeRoot, ".codex"));
  await fs.writeFile(
    path.join(f.homeRoot, ".codex/config.toml"),
    'token = "PRIVATE_EXISTING_VALUE\n',
  );
  const error = await previewInstall({
    target,
    publication: f.publication,
    snapshot: f.snapshot,
    deploymentUrl: "https://badger.example",
  }).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain("PRIVATE_EXISTING_VALUE");
  expect(await fs.readdir(path.join(f.homeRoot, ".codex"))).toEqual([
    "config.toml",
  ]);
});
