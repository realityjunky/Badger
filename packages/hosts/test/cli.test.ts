import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPackageSnapshot, hashDirectory } from "@realityjunky/badger";
const execute = promisify(execFile);
const folders: string[] = [];
let server: http.Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  for (const folder of folders.splice(0))
    await fs.rm(folder, { recursive: true, force: true });
});
it("downloads a hash-bound publication, gives a private actionable preview, and requires its digest to install and uninstall", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-hosts-cli-test-"),
  );
  folders.push(root);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const source = path.join(root, "source");
  await Promise.all([project, home, source].map((p) => fs.mkdir(p)));
  const text =
    "---\nname: report\ndescription: Published report.\n---\n# Report\n";
  await fs.writeFile(path.join(source, "SKILL.md"), text);
  const snapshot = await createPackageSnapshot(source, [
    {
      path: "SKILL.md",
      owner: "auto",
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
  ]);
  let authenticated = false;
  server = http.createServer((request, response) => {
    authenticated = request.headers.authorization === "Bearer test-only-secret";
    expect(request.url).toBe(
      `/team/api/v1/workflows/w-1/publications/p-1/package?packageHash=${snapshot.packageHash}`,
    );
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        publication: { id: "p-1", packageHash: snapshot.packageHash },
        snapshot,
      }),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const cli = path.resolve("dist/src/cli.js");
  const run = (args: string[]) =>
    execute(process.execPath, [cli, ...args], {
      env: { ...process.env, BADGER_TOKEN: "test-only-secret" },
    });
  const target = [
    "--host",
    "codex",
    "--scope",
    "user",
    "--project",
    project,
    "--home",
    home,
  ];
  const result = JSON.parse(
    (
      await run([
        "preview-install",
        ...target,
        "--url",
        `http://127.0.0.1:${port}/team`,
        "--workflow",
        "w-1",
        "--publication",
        "p-1",
        "--package-hash",
        snapshot.packageHash,
      ])
    ).stdout,
  );
  expect(authenticated).toBe(true);
  expect(JSON.stringify(result)).not.toContain("test-only-secret");
  expect(result.commitCommand).toContain(result.preview.digest);
  expect((await fs.stat(result.planFile)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.dirname(result.planFile))).mode & 0o777).toBe(
    0o700,
  );
  folders.push(path.dirname(result.planFile));
  await expect(
    run([
      "commit",
      "--plan",
      result.planFile,
      "--digest",
      result.preview.digest,
    ]),
  ).rejects.toThrow(/confirm/iu);
  await run([
    "commit",
    "--plan",
    result.planFile,
    "--digest",
    result.preview.digest,
    "--confirm",
  ]);
  expect(
    await hashDirectory(path.join(home, ".agents/skills/badger-w-1")),
  ).toBe(snapshot.packageHash);
  expect(await fs.readdir(project)).toEqual([]);
  const uninstall = JSON.parse(
    (await run(["preview-uninstall", ...target, "--workflow", "w-1"])).stdout,
  );
  folders.push(path.dirname(uninstall.planFile));
  await run([
    "commit",
    "--plan",
    uninstall.planFile,
    "--digest",
    uninstall.preview.digest,
    "--confirm",
  ]);
  await expect(
    fs.stat(path.join(home, ".agents/skills/badger-w-1")),
  ).rejects.toThrow();
  await expect(
    fs.stat(path.join(home, ".codex/config.toml")),
  ).rejects.toThrow();
});
