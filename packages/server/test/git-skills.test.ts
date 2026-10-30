import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startStubGitRepository,
  startTestService,
  type StubGitRepositoryOptions,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

const exec = promisify(execFile);
const ORIGIN = "http://localhost";
const admin: TestPerson = {
  subject: "admin",
  email: "admin@example.com",
  displayName: "Administrator",
};
const FILES = {
  "SKILL.md":
    "---\nname: example\ndescription: Example Skill\n---\n\n# Example\n",
  "config/settings.json": "{}\n",
};
let service: TestService;
let remote: Awaited<ReturnType<typeof startStubGitRepository>>;

afterEach(async () => {
  vi.unstubAllEnvs();
  await service?.close();
  await remote?.close();
});
function write(path: string, body: unknown, as = admin) {
  return service.request(`/api/v1${path}`, {
    method: "POST",
    as,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function library(
  files: Record<string, string> = FILES,
  environment: Record<string, string> = {},
  options: StubGitRepositoryOptions = {},
) {
  remote = await startStubGitRepository(files, options);
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: ORIGIN,
      BADGER_GIT_ALLOWED_ORIGINS: remote.origin,
      ...environment,
    },
  });
  const response = await write("/groups", { name: "Research" });
  const { group } = (await response.json()) as { group: { id: string } };
  const created = await write("/skills", {
    groupId: group.id,
    name: "example",
  });
  const { skill } = (await created.json()) as { skill: { id: string } };
  return { skillId: skill.id, groupId: group.id, base: `/skills/${skill.id}` };
}
async function register(base: string): Promise<string> {
  const response = await write(`${base}/repositories`, { url: remote.url });
  return ((await response.json()) as { repository: { id: string } }).repository
    .id;
}
/** Temporary Git and upload workspaces left in the service's storage. */
async function workspaces(): Promise<string[]> {
  return (await fs.readdir(service.config.storage.workspaceDirectory)).filter(
    (name) => name.startsWith("skill-"),
  );
}
/**
 * Plants Git configuration everywhere a Git process looks for it. Each planted
 * command leaves a marker file named after the setting that ran it.
 */
async function plantHostileGit(root: string) {
  const markers = join(root, "markers");
  const mark = join(root, "mark");
  const plant = async (file: string, content: string, mode = 0o644) => {
    await fs.mkdir(dirname(join(root, file)), { recursive: true });
    await fs.writeFile(join(root, file), content, { mode });
  };
  const command = (marker: string) => `#!/bin/sh\n"${mark}" ${marker}\n`;
  await fs.mkdir(markers);
  await plant("mark", `#!/bin/sh\ntouch "${markers}/$1"\n`, 0o755);
  await plant("askpass", command("askpass"), 0o755);
  for (const hook of [
    "post-index-change",
    "reference-transaction",
    "pre-auto-gc",
  ])
    await plant(`hooks/${hook}`, command(`hook-${hook}`), 0o755);
  for (const helper of ["git-remote-http", "git-remote-https"])
    await plant(`exec/${helper}`, command("exec-path"), 0o755);
  const settings: [string, string][] = [
    ["protocol.ext.allow", "always"],
    // Turns the service's own transport URL into a local command.
    [`url.ext::${mark} insteadof .insteadOf`, "http://"],
    ["credential.helper", `!${mark} credential-helper`],
    ["core.askPass", join(root, "askpass")],
    ["core.fsmonitor", `${mark} fsmonitor`],
    ["core.hooksPath", join(root, "hooks")],
    ["core.attributesFile", join(root, "attributes")],
    ["filter.marker.clean", `${mark} filter-clean`],
    ["filter.marker.smudge", `${mark} filter-smudge`],
  ];
  const config = settings
    .map(([key, value]) => {
      const first = key.indexOf(".");
      const last = key.lastIndexOf(".");
      const section =
        first === last
          ? key.slice(0, first)
          : `${key.slice(0, first)} "${key.slice(first + 1, last)}"`;
      return `[${section}]\n\t${key.slice(last + 1)} = "${value}"\n`;
    })
    .join("");
  for (const file of ["global", "system", "home/.gitconfig", "xdg/git/config"])
    await plant(file, config);
  for (const file of ["attributes", "xdg/git/attributes"])
    await plant(file, "* filter=marker\n");
  const parameters: Record<string, string> = {
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(
      settings.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  };
  return {
    markers,
    /** Each way a Git process finds settings, and the marker it then leaves. */
    locations: [
      [{ GIT_CONFIG_GLOBAL: join(root, "global") }, "insteadof"],
      [{ GIT_CONFIG_SYSTEM: join(root, "system") }, "insteadof"],
      [{ HOME: join(root, "home") }, "insteadof"],
      [
        { HOME: join(root, "empty"), XDG_CONFIG_HOME: join(root, "xdg") },
        "insteadof",
      ],
      [parameters, "insteadof"],
      [{ GIT_EXEC_PATH: join(root, "exec") }, "exec-path"],
    ] as [Record<string, string>, string][],
    /** All of them at once. */
    environment: {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg"),
      GIT_CONFIG_GLOBAL: join(root, "global"),
      GIT_CONFIG_SYSTEM: join(root, "system"),
      GIT_CONFIG_NOSYSTEM: "0",
      ...parameters,
      GIT_EXEC_PATH: join(root, "exec"),
      GIT_ASKPASS: join(root, "askpass"),
      GIT_TRACE: join(markers, "trace"),
    },
    /** The markers left so far, sorted; taking them clears them. */
    async take(): Promise<string[]> {
      const found = (await fs.readdir(markers)).sort();
      await fs.rm(markers, { recursive: true });
      await fs.mkdir(markers);
      return found;
    },
  };
}

describe("Skill versions from registered Git repositories", () => {
  it.each([
    { format: "sha1", protocol: 0 },
    { format: "sha1", protocol: 2 },
    { format: "sha256", protocol: 2 },
  ] as const)(
    "imports the exact committed $format tree over protocol v$protocol with upload identity and durable Git provenance",
    async ({ format, protocol }) => {
      const { base } = await library(
        FILES,
        {},
        { objectFormat: format, protocol },
      );
      expect(remote.commit).toHaveLength(format === "sha256" ? 64 : 40);
      const registered = await write(`${base}/repositories`, {
        url: remote.url,
      });
      expect(registered.status).toBe(201);
      const { repository } = (await registered.json()) as {
        repository: { id: string };
      };
      const content = { repositoryId: repository.id, commit: remote.commit };
      const preview = await write(`${base}/git-preview`, content);
      expect(preview.status).toBe(200);
      const { preview: inspected } = (await preview.json()) as {
        preview: { hash: string; inventory: { path: string }[] };
      };
      expect(inspected.hash).toBe(
        "dd2ee5b7b2a5d823c4a44e5be4daa21bf8b3b0735df9307770672918f51371fc",
      );
      const imported = await write(`${base}/versions`, {
        ...content,
        confirmed: true,
        expectedHash: inspected.hash,
      });
      expect(imported.status).toBe(201);
      const { version } = (await imported.json()) as {
        version: { hash: string };
      };
      expect(version).toMatchObject({
        origin: "git",
        gitOrigins: [
          {
            repositoryId: repository.id,
            repository: remote.url,
            commit: remote.commit,
          },
        ],
      });
      const uploaded = await write(`${base}/versions`, {
        files: Object.entries(FILES).map(([path, text]) => ({
          path,
          content: Buffer.from(text).toString("base64"),
        })),
        confirmed: true,
        expectedHash: inspected.hash,
      });
      expect(uploaded.status).toBe(200);
      const read = await service.request(
        `/api/v1${base}/versions/${version.hash}`,
        { as: admin },
      );
      expect(await read.json()).toMatchObject({ version });
      const file = await service.request(
        `/api/v1${base}/versions/${version.hash}/files?path=config/settings.json`,
        { as: admin },
      );
      expect(await file.json()).toMatchObject({ content: "{}\n" });
      // Each request to the host joins one smart-HTTP operation to the
      // registered path.
      expect(new Set(remote.requests)).toEqual(
        new Set([
          "/source.git/info/refs?service=git-upload-pack",
          "/source.git/git-upload-pack",
        ]),
      );
      expect(new Set(remote.protocols)).toEqual(new Set([protocol]));
    },
  );
  it("records Git provenance when the content was uploaded first, without making another version", async () => {
    const { base } = await library();
    const upload = await write(`${base}/versions`, {
      files: Object.entries(FILES).map(([path, text]) => ({
        path,
        content: Buffer.from(text).toString("base64"),
      })),
      confirmed: true,
      expectedHash:
        "dd2ee5b7b2a5d823c4a44e5be4daa21bf8b3b0735df9307770672918f51371fc",
    });
    expect(upload.status).toBe(201);
    const { repository } = (await (
      await write(`${base}/repositories`, { url: remote.url })
    ).json()) as { repository: { id: string } };
    const content = {
      repositoryId: repository.id,
      commit: remote.commit,
      confirmed: true,
      expectedHash:
        "dd2ee5b7b2a5d823c4a44e5be4daa21bf8b3b0735df9307770672918f51371fc",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const imported = await write(`${base}/versions`, content);
      expect(imported.status).toBe(200);
      expect(await imported.json()).toMatchObject({
        version: {
          origin: "upload",
          gitOrigins: [
            {
              repositoryId: repository.id,
              repository: remote.url,
              commit: remote.commit,
            },
          ],
        },
      });
    }
    const versions = await service.request(`/api/v1${base}/versions`, {
      as: admin,
    });
    expect(
      ((await versions.json()) as { versions: unknown[] }).versions,
    ).toHaveLength(1);
    const activity = await service.request(
      "/api/v1/audit-events?action=skill_version.imported",
      { as: admin },
    );
    expect(
      ((await activity.json()) as { events: unknown[] }).events,
    ).toHaveLength(1);
  });

  it("refuses unregistered repositories, unsafe URLs, moving refs, and missing confirmation before fetching", async () => {
    const { base, groupId } = await library();
    for (const url of [
      "file:///etc",
      "ext::touch /tmp/no",
      "https://user:secret@example.com/repo",
      "https://example.com/repo?token=secret",
      // An empty query or fragment parses to an empty search or hash.
      `${remote.url}?`,
      `${remote.url}#`,
      `${remote.url}/?#`,
    ]) {
      expect((await write(`${base}/repositories`, { url })).status).toBe(400);
    }
    expect(
      (
        await write(`${base}/repositories`, {
          url: "https://unapproved.example/repo",
        })
      ).status,
    ).toBe(403);
    expect(remote.requests).toHaveLength(0);
    expect(
      await (
        await service.request(`/api/v1${base}/repositories`, { as: admin })
      ).json(),
    ).toEqual({ repositories: [] });
    const { repository } = (await (
      await write(`${base}/repositories`, { url: remote.url })
    ).json()) as { repository: { id: string } };
    const input = { repositoryId: repository.id, commit: remote.commit };
    expect(
      (
        await write(`${base}/git-preview`, {
          ...input,
          repositoryId: "unknown",
        })
      ).status,
    ).toBe(404);
    for (const commit of [
      "HEAD",
      "main",
      remote.commit.slice(0, 12),
      "--upload-pack=touch",
    ]) {
      expect(
        (await write(`${base}/git-preview`, { ...input, commit })).status,
      ).toBe(400);
    }
    expect((await write(`${base}/versions`, input)).status).toBe(400);
    expect(
      (await write(`${base}/versions`, { ...input, confirmed: true })).status,
    ).toBe(400);
    const other = (await (
      await write("/skills", { groupId, name: "other" })
    ).json()) as { skill: { id: string } };
    expect(
      (await write(`/skills/${other.skill.id}/git-preview`, input)).status,
    ).toBe(404);
    expect(remote.requests).toHaveLength(0);
    expect(
      (
        await write(`${base}/versions`, {
          ...input,
          confirmed: true,
          expectedHash: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
    const versions = await service.request(`/api/v1${base}/versions`, {
      as: admin,
    });
    expect(await versions.json()).toEqual({ versions: [] });
  });

  it.each([0, 2] as const)(
    "keeps script declarations immutable and never runs fetched content, host Git configuration, or export rules over protocol v%i",
    async (protocol) => {
      const root = await fs.mkdtemp(join(tmpdir(), "badger-hostile-git-"));
      try {
        const hostile = await plantHostileGit(root);
        const touching = (marker: string) =>
          `#!/bin/sh\ntouch "${hostile.markers}/${marker}"\n`;
        const files = {
          "SKILL.md":
            "---\nname: example\ndescription: Example Skill\n---\n\n# Example\n\nCommitted as $Format:%H$.\n",
          "config/settings.json": "{}\n",
          "scripts/run.sh": touching("committed-script"),
          "hooks/post-checkout": touching("committed-hook"),
          ".githooks/reference-transaction": touching("committed-hook"),
          ".gitattributes":
            "* filter=marker\nSKILL.md export-subst\nconfig/settings.json export-ignore\n",
          ".DS_Store": "host noise",
        };
        const { base: target } = await library(
          files,
          {},
          {
            protocol,
            executable: [
              "scripts/run.sh",
              "hooks/post-checkout",
              ".githooks/reference-transaction",
            ],
          },
        );
        // Each planted location takes over a Git that reads it.
        const limit = { timeout: 10_000 };
        for (const [location, marker] of hostile.locations) {
          await exec("git", ["ls-remote", remote.url], {
            ...limit,
            env: { PATH: process.env["PATH"], ...location },
          }).catch(() => undefined);
          expect(await hostile.take()).toContain(marker);
        }
        // The service runs in this process, so its Git could inherit them.
        for (const [name, value] of Object.entries(hostile.environment))
          vi.stubEnv(name, value);
        const probe = join(root, "probe");
        await exec("git", ["init", "--quiet", probe], limit);
        await fs.writeFile(join(probe, "file"), "content\n");
        await exec("git", ["-C", probe, "add", "file"], limit);
        await exec("git", ["-C", probe, "status"], limit);
        const fill = exec("git", ["credential", "fill"], limit);
        fill.child.stdin?.end("protocol=https\nhost=example.com\n\n");
        await fill.catch(() => undefined);
        expect(await hostile.take()).toEqual(
          expect.arrayContaining([
            "askpass",
            "credential-helper",
            "filter-clean",
            "fsmonitor",
            "hook-post-index-change",
            "trace",
          ]),
        );

        const { repository } = (await (
          await write(`${target}/repositories`, { url: remote.url })
        ).json()) as { repository: { id: string } };
        const input = { repositoryId: repository.id, commit: remote.commit };
        const preview = await write(`${target}/git-preview`, input);
        expect(await hostile.take()).toEqual([]);
        expect(preview.status).toBe(200);
        const { preview: inspected } = (await preview.json()) as {
          preview: {
            hash: string;
            scripts: unknown[];
            inventory: { path: string }[];
          };
        };
        expect(inspected.scripts).toMatchObject([
          { path: "scripts/run.sh", sideEffects: "undeclared" },
        ]);
        expect(inspected.inventory.map((entry) => entry.path)).toEqual([
          ".gitattributes",
          ".githooks/reference-transaction",
          "SKILL.md",
          "config/settings.json",
          "hooks/post-checkout",
          "scripts/run.sh",
        ]);
        const confirmation = {
          ...input,
          confirmed: true,
          expectedHash: inspected.hash,
        };
        expect((await write(`${target}/versions`, confirmation)).status).toBe(
          400,
        );
        // A refused import leaves no temporary repository behind.
        expect(await workspaces()).toEqual([]);
        const created = await write(`${target}/versions`, {
          ...confirmation,
          scripts: { "scripts/run.sh": ["none"] },
        });
        expect(created.status).toBe(201);
        expect(
          (
            await write(`${target}/versions`, {
              ...confirmation,
              scripts: { "scripts/run.sh": ["network"] },
            })
          ).status,
        ).toBe(409);
        // Export rules stay ordinary content: no substitution or omission.
        const skill = await service.request(
          `/api/v1${target}/versions/${inspected.hash}/files?path=SKILL.md`,
          { as: admin },
        );
        expect(await skill.json()).toMatchObject({
          content: files["SKILL.md"],
        });
        const upload = await write(`${target}/versions`, {
          files: Object.entries(files).map(([path, text]) => ({
            path,
            content: Buffer.from(text).toString("base64"),
          })),
          confirmed: true,
          expectedHash: inspected.hash,
          scripts: { "scripts/run.sh": ["none"] },
        });
        expect(upload.status).toBe(200);
        expect(await hostile.take()).toEqual([]);
        expect(await workspaces()).toEqual([]);
        expect(new Set(remote.protocols)).toEqual(new Set([protocol]));
      } finally {
        vi.unstubAllEnvs();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects links and submodules without changing the version library", async () => {
    const { base } = await library();
    const { repository } = (await (
      await write(`${base}/repositories`, { url: remote.url })
    ).json()) as { repository: { id: string } };
    for (const commit of [
      await remote.gitlink(),
      await remote.symlink("escape", "../../outside"),
    ]) {
      const response = await write(`${base}/git-preview`, {
        repositoryId: repository.id,
        commit,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining("links and submodules") },
      });
    }
    expect(
      await (
        await service.request(`/api/v1${base}/versions`, { as: admin })
      ).json(),
    ).toEqual({ versions: [] });
  });

  it.each([
    // Git's own object checks refuse a name that HFS+ resolves to .git.
    { file: "reference/.g\u200cit/config", refusedBy: "the fetch" },
    // Only case folding resolves this name to .git, so it reaches the rule
    // uploads share: "\u0131" is a dotless i, which uppercases to I.
    { file: "reference/.g\u0131t/config", refusedBy: "the upload path rule" },
  ])(
    "refuses a tree name that resolves to .git, at $refusedBy",
    async ({ file, refusedBy }) => {
      const { base } = await library({
        ...FILES,
        [file]: "[core]\n\tfsmonitor = x\n",
      });
      const repositoryId = await register(base);
      for (const route of ["git-preview", "versions"]) {
        const response = await write(`${base}/${route}`, {
          repositoryId,
          commit: remote.commit,
          confirmed: true,
          expectedHash: "0".repeat(64),
        });
        expect(response.status, route).toBe(400);
        const { error } = await response.json();
        expect(error.code).toBe("invalid");
        if (refusedBy === "the upload path rule")
          expect(error.message).toBe(
            `Upload path "${file}" contains a .git folder; upload the Skill without its .git folder, for example from git archive output`,
          );
      }
      expect(
        await (
          await service.request(`/api/v1${base}/versions`, { as: admin })
        ).json(),
      ).toEqual({ versions: [] });
    },
  );

  it("rejects redirects and dumb HTTP before following other repository URLs", async () => {
    const { base } = await library();
    const other = await startStubGitRepository(FILES);
    try {
      const { repository } = (await (
        await write(`${base}/repositories`, { url: remote.url })
      ).json()) as { repository: { id: string } };
      remote.serveDumbRefs();
      expect(
        (
          await write(`${base}/git-preview`, {
            repositoryId: repository.id,
            commit: remote.commit,
          })
        ).status,
      ).toBe(400);
      remote.redirectTo(other.url);
      expect(
        (
          await write(`${base}/git-preview`, {
            repositoryId: repository.id,
            commit: remote.commit,
          })
        ).status,
      ).toBe(400);
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it.each([
    ["BADGER_UPLOAD_MAX_FILES", "1"],
    ["BADGER_UPLOAD_MAX_FILE_BYTES", "20"],
    ["BADGER_UPLOAD_MAX_BYTES", "20"],
    ["BADGER_GIT_MAX_REPOSITORY_BYTES", "1024"],
  ])("bounds fetched content with %s", async (name, limit) => {
    const { base } = await library(
      { ...FILES, "reference/large.txt": "x".repeat(5000) },
      { [name]: limit },
    );
    const { repository } = (await (
      await write(`${base}/repositories`, { url: remote.url })
    ).json()) as { repository: { id: string } };
    const response = await write(`${base}/git-preview`, {
      repositoryId: repository.id,
      commit: remote.commit,
    });
    expect(response.status).toBe(413);
  });

  it("refuses highly compressed oversized objects and keeps serving after the refusal", async () => {
    const { base } = await library(
      { ...FILES, "reference/compressed.txt": "x".repeat(64 * 1024 * 1024) },
      { BADGER_UPLOAD_MAX_BYTES: "2048", BADGER_UPLOAD_MAX_FILE_BYTES: "1024" },
    );
    const { repository } = (await (
      await write(`${base}/repositories`, { url: remote.url })
    ).json()) as { repository: { id: string } };
    const response = await write(`${base}/git-preview`, {
      repositoryId: repository.id,
      commit: remote.commit,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { message: "Git objects exceed the allocation limit" },
    });
    expect((await service.request("/health")).status).toBe(200);
    expect(
      await (
        await service.request(`/api/v1${base}/versions`, { as: admin })
      ).json(),
    ).toEqual({ versions: [] });
  });

  it("times out an unresponsive Git server as unavailable", async () => {
    const { base } = await library(FILES, { BADGER_GIT_TIMEOUT_MS: "200" });
    const { repository } = (await (
      await write(`${base}/repositories`, { url: remote.url })
    ).json()) as { repository: { id: string } };
    remote.stall();
    const response = await write(`${base}/git-preview`, {
      repositoryId: repository.id,
      commit: remote.commit,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "unavailable", message: "Git import timed out" },
    });
    expect(await workspaces()).toEqual([]);
  });

  it("reports a failing Git host or a server without Git as unavailable, and other host answers as invalid", async () => {
    const { base } = await library();
    const repositoryId = await register(base);
    const preview = () =>
      write(`${base}/git-preview`, { repositoryId, commit: remote.commit });
    for (const status of [500, 502, 503, 429]) {
      remote.failWith(status);
      const response = await preview();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "unavailable" },
      });
    }
    // Retrying cannot help when the host answers but serves no repository.
    remote.failWith(404);
    const absent = await preview();
    expect(absent.status).toBe(400);
    expect(await absent.json()).toMatchObject({ error: { code: "invalid" } });
    vi.stubEnv("PATH", join(tmpdir(), "badger-no-git-here"));
    const withoutGit = await preview();
    vi.unstubAllEnvs();
    expect(withoutGit.status).toBe(503);
    expect(await withoutGit.json()).toMatchObject({
      error: {
        code: "unavailable",
        message: "Git is unavailable on this server",
      },
    });
    await remote.close();
    const unreachable = await preview();
    expect(unreachable.status).toBe(503);
    expect(await unreachable.json()).toMatchObject({
      error: { code: "unavailable" },
    });
    expect(await workspaces()).toEqual([]);
  });

  it.each([0, 2] as const)(
    "refuses a commit the repository cannot supply as invalid over protocol v%i",
    async (protocol) => {
      const { base } = await library(FILES, {}, { protocol });
      const repositoryId = await register(base);
      const response = await write(`${base}/git-preview`, {
        repositoryId,
        commit: "1".repeat(40),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "invalid",
          message: "The registered repository could not supply that commit",
        },
      });
      expect(remote.requests).not.toHaveLength(0);
      expect(await workspaces()).toEqual([]);
    },
  );

  it("runs at most two Git fetches at once and refuses more as unavailable with Retry-After", async () => {
    const { base } = await library();
    const repositoryId = await register(base);
    const input = { repositoryId, commit: remote.commit };
    const release = remote.hold();
    const running = [
      write(`${base}/git-preview`, input),
      write(`${base}/versions`, {
        ...input,
        confirmed: true,
        expectedHash:
          "dd2ee5b7b2a5d823c4a44e5be4daa21bf8b3b0735df9307770672918f51371fc",
      }),
    ];
    await vi.waitFor(() => expect(remote.requests).toHaveLength(2), {
      timeout: 10_000,
    });
    const refused = await write(`${base}/git-preview`, input);
    expect(refused.status).toBe(503);
    // The Git timeout, by which a running fetch has ended, in seconds.
    expect(refused.headers.get("retry-after")).toBe("30");
    expect(await refused.json()).toMatchObject({
      error: {
        code: "unavailable",
        message: expect.stringContaining("At most 2 Git imports run at once"),
      },
    });
    expect(remote.requests).toHaveLength(2);
    release();
    expect(
      (await Promise.all(running)).map((response) => response.status),
    ).toEqual([200, 201]);
    expect((await write(`${base}/git-preview`, input)).status).toBe(200);
  });

  it("refuses Git LFS content, which an import cannot fetch, and asks for an upload", async () => {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12345\n`;
    const { base } = await library({
      ...FILES,
      ".gitattributes": "# *.bin filter=lfs diff=lfs merge=lfs -text\n",
      "reference/lfs.md": `Pointers look like this:\n\n${pointer}`,
    });
    const repositoryId = await register(base);
    // A commented-out rule assigns no attribute, and a quoted pointer is text.
    expect(
      (
        await write(`${base}/git-preview`, {
          repositoryId,
          commit: remote.commit,
        })
      ).status,
    ).toBe(200);
    // Each commit is refused for one reason: the root attributes, nested
    // attributes, or a pointer committed without LFS attributes.
    const tracked = await remote.commitFiles({
      ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      "assets/model.bin": "model\n",
    });
    const nested = await remote.commitFiles({
      ".gitattributes": "*.txt text\n",
      "reference/.gitattributes": "weights.pt -text filter=lfs\n",
      "reference/weights.pt": "weights\n",
    });
    const stub = await remote.commitFiles({
      "reference/.gitattributes": "weights.pt -text\n",
      "reference/weights.pt": pointer,
    });
    for (const commit of [tracked, nested, stub]) {
      for (const route of ["git-preview", "versions"]) {
        const response = await write(`${base}/${route}`, {
          repositoryId,
          commit,
          confirmed: true,
          expectedHash: "0".repeat(64),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            code: "invalid",
            message: expect.stringContaining("upload the Skill folder instead"),
          },
        });
      }
    }
    expect(
      await (
        await service.request(`/api/v1${base}/versions`, { as: admin })
      ).json(),
    ).toEqual({ versions: [] });
    expect(await workspaces()).toEqual([]);
  });

  it("uses the same Field expert and Engineer permissions as uploads, including denials before fetch", async () => {
    const { base, groupId } = await library();
    const { workflow } = (await (
      await write("/workflows", {
        groupId,
        name: "source-registration",
        goal: "Collect sources",
        intent: "new-skill",
        locale: "en",
      })
    ).json()) as { workflow: { id: string } };
    for (const role of ["Engineer", "Field expert", "Observer"]) {
      const person = {
        subject: role,
        email: `${role.toLowerCase().replace(" ", "-")}@example.com`,
        displayName: role,
      };
      expect(
        (
          await write("/bindings", {
            scopeType: "workflow",
            scopeId: workflow.id,
            email: person.email,
            role,
          })
        ).status,
      ).toBe(201);
      const before = remote.requests.length;
      const response = await write(
        `${base}/repositories`,
        { url: remote.url },
        person,
      );
      if (role === "Observer") {
        expect(response.status).toBe(403);
        const { repositories } = (await (
          await service.request(`/api/v1${base}/repositories`, { as: person })
        ).json()) as { repositories: { id: string }[] };
        expect(
          (
            await write(
              `${base}/git-preview`,
              { repositoryId: repositories[0]!.id, commit: remote.commit },
              person,
            )
          ).status,
        ).toBe(403);
        expect(remote.requests).toHaveLength(before);
      } else {
        expect(response.status).toBe(role === "Engineer" ? 201 : 200);
        const { repository } = (await response.json()) as {
          repository: { id: string };
        };
        const input = { repositoryId: repository.id, commit: remote.commit };
        expect((await write(`${base}/git-preview`, input, person)).status).toBe(
          200,
        );
        expect(
          (
            await write(
              `${base}/versions`,
              {
                ...input,
                confirmed: true,
                expectedHash:
                  "dd2ee5b7b2a5d823c4a44e5be4daa21bf8b3b0735df9307770672918f51371fc",
              },
              person,
            )
          ).status,
        ).toBe(role === "Engineer" ? 201 : 200);
      }
    }
    const outsider = {
      subject: "outsider",
      email: "out@example.com",
      displayName: "Outsider",
    };
    const before = remote.requests.length;
    expect(
      (await write(`${base}/repositories`, { url: remote.url }, outsider))
        .status,
    ).toBe(404);
    expect(remote.requests).toHaveLength(before);
  });
});
