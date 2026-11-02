import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

const ORIGIN = "http://localhost";
const administrator: TestPerson = {
  subject: "admin",
  email: "admin@example.com",
  displayName: "Library Administrator",
};
const SKILL_MD =
  "---\nname: example\ndescription: Example Skill\n---\n\n# Example\n";
/** A well-formed hash that matches no source, so inspection refuses first. */
const UNCHECKED_HASH = "0".repeat(64);
let service: TestService;

afterEach(async () => {
  await service?.close();
});

function write(
  path: string,
  body: unknown,
  as = administrator,
  method = "POST",
) {
  return service.request(path, {
    method,
    as,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function startLibrary(environment: Record<string, string> = {}) {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: administrator.email,
      BADGER_ALLOWED_ORIGINS: ORIGIN,
      ...environment,
    },
  });
  const groupResponse = await write("/api/v1/groups", { name: "Research" });
  expect(groupResponse.status).toBe(201);
  const { group } = (await groupResponse.json()) as { group: { id: string } };
  const response = await write("/api/v1/skills", {
    groupId: group.id,
    name: "example",
  });
  expect(response.status).toBe(201);
  const { skill } = (await response.json()) as { skill: { id: string } };
  return { groupId: group.id, skillId: skill.id };
}

function file(path: string, content: string) {
  return { path, content: Buffer.from(content).toString("base64") };
}

function versionsPath(skillId: string) {
  return `/api/v1/skills/${skillId}/versions`;
}

interface Preview {
  hash: string;
  inventory: { path: string }[];
}

async function previewOf(
  skillId: string,
  content: Record<string, unknown>,
  as = administrator,
): Promise<Preview> {
  const response = await write(
    `/api/v1/skills/${skillId}/upload-preview`,
    content,
    as,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { preview: Preview }).preview;
}

/** The body that confirms `content` after previewing it, as the dashboard does. */
async function confirmation(
  skillId: string,
  content: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { hash } = await previewOf(skillId, content);
  return { ...content, confirmed: true, expectedHash: hash };
}

async function upload(
  skillId: string,
  content: Record<string, unknown>,
  as = administrator,
) {
  return write(versionsPath(skillId), await confirmation(skillId, content), as);
}

interface ZipEntry {
  name: string | Buffer;
  data?: string;
  /** General-purpose flags; the default marks the name as UTF-8. */
  flags?: number;
  extra?: Buffer;
  directory?: boolean;
}

/** A zip of stored (uncompressed) entries, built byte by byte. */
function zip(entries: ZipEntry[]): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name)
      ? entry.name
      : Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const extra = entry.extra ?? Buffer.alloc(0);
    const flags = entry.flags ?? 0x800;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(
      ((entry.directory ? 0o40755 : 0o100644) << 16) >>> 0,
      38,
    );
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, data);
    centrals.push(central, name, extra);
    offset += local.length + name.length + extra.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]).toString("base64");
}

/** An Info-ZIP Unicode Path extra field naming `raw` as `name`. */
function unicodePath(raw: Buffer, name: string): Buffer {
  const utf8 = Buffer.from(name);
  const field = Buffer.alloc(9 + utf8.length);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(5 + utf8.length, 2);
  field.writeUInt8(1, 4);
  field.writeUInt32LE(crc32(raw), 5);
  utf8.copy(field, 9);
  return field;
}

async function createWorkflow(groupId: string, name: string) {
  const response = await write("/api/v1/workflows", {
    groupId,
    name,
    goal: "Build a workflow",
    intent: "new-skill",
    locale: "en",
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { workflow: { id: string } }).workflow;
}

async function assignWorkflowRole(
  workflowId: string,
  person: TestPerson,
  role: string,
) {
  const response = await write("/api/v1/bindings", {
    scopeType: "workflow",
    scopeId: workflowId,
    email: person.email,
    role,
  });
  expect(response.status, role).toBe(201);
  return (
    (await response.json()) as { binding: { id: string; revision: number } }
  ).binding;
}

function removeBinding(binding: { id: string; revision: number }) {
  return write(
    `/api/v1/bindings/${binding.id}`,
    { revision: binding.revision },
    administrator,
    "DELETE",
  );
}

describe("Skill versions by upload", () => {
  it("refuses .git path segments in folder previews and confirmed uploads", async () => {
    const { skillId } = await startLibrary();
    for (const gitPath of [
      ".git/config",
      "example/.git/config",
      "reference/.GIT/config",
      // Spellings that HFS+ resolves to .git.
      ".g\u200cit/config",
      "reference/.Gi\ufefft/HEAD",
      "docs/.git\u200e.\u200f/config",
    ]) {
      const content = {
        files: [file("SKILL.md", SKILL_MD), file(gitPath, "private history")],
      };
      for (const action of ["upload-preview", "versions"]) {
        const response = await write(`/api/v1/skills/${skillId}/${action}`, {
          ...content,
          ...(action === "versions"
            ? { confirmed: true, expectedHash: UNCHECKED_HASH }
            : {}),
        });
        expect(response.status, `${action}: ${gitPath}`).toBe(400);
        const { error } = await response.json();
        expect(error.message).toContain(gitPath);
        expect(error.message).toMatch(/without its \.git folder.*git archive/u);
      }
    }
    const versions = await service.request(versionsPath(skillId), {
      as: administrator,
    });
    expect(await versions.json()).toEqual({ versions: [] });
  });

  it("checks path lengths before .git segments, so a refusal names a bounded path", async () => {
    const { skillId } = await startLibrary();
    const long = Array.from({ length: 5 }, () => "a".repeat(250)).join("/");
    for (const [gitPath, message] of [
      [`${long}/.git/config`, "Upload paths are limited to 1024 bytes"],
      [
        `${"b".repeat(300)}/.git/config`,
        "Each upload path segment is limited to 255 bytes",
      ],
      [
        `${"./".repeat(1000)}.git/config`,
        'Upload path ".git/config" contains a .git folder',
      ],
    ]) {
      const response = await write(`/api/v1/skills/${skillId}/upload-preview`, {
        files: [file("SKILL.md", SKILL_MD), file(gitPath!, "private history")],
      });
      expect(response.status).toBe(400);
      const { error } = await response.json();
      expect(error.message).toContain(message);
      expect(error.message.length).toBeLessThan(1300);
    }
  });

  it("keeps a kernel-identified immutable version, its full inventory, and safe previews", async () => {
    const { skillId } = await startLibrary();
    const response = await upload(skillId, {
      files: [file("SKILL.md", SKILL_MD), file("config/settings.json", "{}\n")],
    });
    expect(response.status).toBe(201);
    const { version } = (await response.json()) as {
      version: { hash: string; inventory: { path: string; hash: string }[] };
    };
    expect(version.hash).toBe(
      "dd2ee5b7b2a5d823c4a44e5be4daa21bf8b3b0735df9307770672918f51371fc",
    );
    expect(version.inventory.map((entry) => entry.path)).toEqual([
      "SKILL.md",
      "config/settings.json",
    ]);
    expect(version.inventory[1]?.hash).toBe(
      "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
    );
    const duplicate = await upload(skillId, {
      files: [
        file("example/config/settings.json", "{}\n"),
        file("example/SKILL.md", SKILL_MD),
        file("example/.DS_Store", "desktop noise"),
      ],
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ version });
    const versions = await service.request(versionsPath(skillId), {
      as: administrator,
    });
    expect(await versions.json()).toMatchObject({ versions: [version] });
    const preview = await service.request(
      `${versionsPath(skillId)}/${version.hash}/files?path=config%2Fsettings.json`,
      { as: administrator },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      content: "{}\n",
      binary: false,
    });
    const update = await service.request(
      `${versionsPath(skillId)}/${version.hash}`,
      { method: "PUT", as: administrator, headers: { origin: ORIGIN } },
    );
    expect(update.status).toBe(405);
    const audit = await service.request(
      "/api/v1/audit-events?action=skill_version.uploaded",
      {
        as: administrator,
      },
    );
    expect(await audit.json()).toMatchObject({
      events: [{ targetType: "skill_version", after: { hash: version.hash } }],
    });
  });

  it("refuses .git entries in zip previews and confirmed uploads, including empty directories and metadata", async () => {
    const { skillId } = await startLibrary();
    for (const entry of [
      { name: ".git/config", data: "private history" },
      { name: "example/reference/.git/config", data: "private history" },
      { name: ".git/", directory: true },
      { name: "__MACOSX/.git/config", data: "private history" },
      { name: "example/.g\u200dit/config", data: "private history" },
    ]) {
      for (const action of ["upload-preview", "versions"]) {
        const response = await write(`/api/v1/skills/${skillId}/${action}`, {
          archive: zip([{ name: "SKILL.md", data: SKILL_MD }, entry]),
          ...(action === "versions"
            ? { confirmed: true, expectedHash: UNCHECKED_HASH }
            : {}),
        });
        expect(response.status, `${action}: ${entry.name}`).toBe(400);
        const { error } = await response.json();
        // The refusal names the normalized path.
        expect(error.message).toContain(`"${entry.name.replace(/\/$/u, "")}"`);
        expect(error.message).toMatch(/without its \.git folder.*git archive/u);
      }
    }
  });

  it("uploads a zip without running scripts and binds their side effects immutably", async () => {
    const { skillId } = await startLibrary();
    const archive =
      "UEsDBBQAAAAIAFCKXF0XQtDYMgAAADwAAAAQAAAAZXhhbXBsZS9TS0lMTC5tZNPV1eXKS8xNtVJIrUjMLchJ5UpJLU4uyiwoyczPs1JwhQgqBGdn5uRw6QIVcynDBLkAUEsDBBQAAAAIAFCKXF2L+KIZHQAAABsAAAAWAAAAZXhhbXBsZS9zY3JpcHRzL3J1bi5zaFNW1E/KzNMvzuAqKMrMK0lTyEstSy3SLSrN4wIAUEsBAhQDFAAAAAgAUIpcXRdC0NgyAAAAPAAAABAAAAAAAAAAAAAAAIABAAAAAGV4YW1wbGUvU0tJTEwubWRQSwECFAMUAAAACABQilxdi/iiGR0AAAAbAAAAFgAAAAAAAAAAAAAAgAFgAAAAZXhhbXBsZS9zY3JpcHRzL3J1bi5zaFBLBQYAAAAAAgACAIIAAACxAAAAAAA=";
    const response = await upload(skillId, {
      archive,
      scripts: { "scripts/run.sh": ["local-writes", "network"] },
    });
    expect(response.status).toBe(201);
    const { version } = (await response.json()) as {
      version: { hash: string; scripts: unknown[] };
    };
    expect(version.scripts).toEqual([
      { path: "scripts/run.sh", sideEffects: ["local-writes", "network"] },
    ]);
    const duplicate = await upload(skillId, {
      files: [
        file("SKILL.md", SKILL_MD),
        file("scripts/run.sh", "#!/bin/sh\nprintf never-run\n"),
      ],
      scripts: { "scripts/run.sh": ["network", "local-writes"] },
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ version });
    const conflicting = await upload(skillId, {
      archive,
      scripts: { "scripts/run.sh": "none" },
    });
    expect(conflicting.status).toBe(409);
    const invalid = await write(versionsPath(skillId), {
      confirmed: true,
      expectedHash: version.hash,
      archive,
      scripts: { "scripts/run.sh": ["none", "network"] },
    });
    expect(invalid.status).toBe(400);
  });

  it("lets workflow Engineers and Field experts contribute only in their workflow's group, with immediate role revocation", async () => {
    const { groupId, skillId } = await startLibrary();
    const expert: TestPerson = {
      subject: "expert",
      email: "expert@example.com",
      displayName: "Field Expert",
    };
    const workflow = await createWorkflow(groupId, "research-workflow");
    const confirmed = await confirmation(skillId, {
      files: [file("SKILL.md", SKILL_MD)],
    });
    expect((await write(versionsPath(skillId), confirmed, expert)).status).toBe(
      404,
    );
    const binding = await assignWorkflowRole(
      workflow.id,
      expert,
      "Field expert",
    );
    const uploaded = await write(versionsPath(skillId), confirmed, expert);
    expect(uploaded.status).toBe(201);
    const catalog = await service.request("/api/v1/skills", { as: expert });
    expect(await catalog.json()).toMatchObject({
      skills: [{ id: skillId, canUpload: true }],
    });
    expect((await removeBinding(binding)).status).toBe(200);
    expect((await write(versionsPath(skillId), confirmed, expert)).status).toBe(
      404,
    );
  });

  it("previews before confirmation, requires every script's declaration, and compares any two versions without losing old files", async () => {
    const { skillId } = await startLibrary();
    const first = {
      files: [
        file("SKILL.md", SKILL_MD),
        file("reference/old.md", "old\n"),
        file("scripts/run.sh", "exit 0\n"),
      ],
    };
    const preview = await write(
      `/api/v1/skills/${skillId}/upload-preview`,
      first,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      preview: {
        scripts: [{ path: "scripts/run.sh", sideEffects: "undeclared" }],
      },
    });
    const before = await service.request(versionsPath(skillId), {
      as: administrator,
    });
    expect(await before.json()).toEqual({ versions: [] });
    expect((await write(versionsPath(skillId), first)).status).toBe(400);
    const undeclared = await write(
      versionsPath(skillId),
      await confirmation(skillId, first),
    );
    expect(undeclared.status).toBe(400);
    expect(await undeclared.json()).toMatchObject({
      error: { message: expect.stringContaining("scripts/run.sh") },
    });
    const created = await upload(skillId, {
      ...first,
      scripts: { "scripts/run.sh": "local-writes" },
    });
    expect(created.status).toBe(201);
    const { version: original } = (await created.json()) as {
      version: { hash: string };
    };
    const second = await upload(skillId, {
      files: [
        file("SKILL.md", `${SKILL_MD}\nNew guidance\n`),
        file("config/new.json", "true\n"),
        file("scripts/run.sh", "exit 0\n"),
      ],
      scripts: { "scripts/run.sh": "none" },
    });
    const { version: updated } = (await second.json()) as {
      version: { hash: string };
    };
    expect(second.status).toBe(201);
    const response = await service.request(
      `/api/v1/skills/${skillId}/diff?from=${original.hash}&to=${updated.hash}`,
      { as: administrator },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      from: original.hash,
      to: updated.hash,
      files: [
        { path: "SKILL.md", status: "modified" },
        { path: "config/new.json", status: "added" },
        { path: "reference/old.md", status: "removed" },
      ],
      scripts: [
        { path: "scripts/run.sh", before: ["local-writes"], after: ["none"] },
      ],
    });
    const old = await service.request(
      `${versionsPath(skillId)}/${original.hash}/files?path=reference/old.md`,
      { as: administrator },
    );
    expect(await old.json()).toMatchObject({ content: "old\n" });
  });

  it("refuses escaping or colliding paths, links, malformed files, and expanded uploads over their limits", async () => {
    const { skillId } = await startLibrary({
      BADGER_UPLOAD_MAX_BYTES: "1024",
      BADGER_UPLOAD_MAX_FILE_BYTES: "512",
      BADGER_UPLOAD_MAX_FILES: "4",
    });
    const endpoint = versionsPath(skillId);
    const refused = (content: Record<string, unknown>) =>
      write(endpoint, {
        ...content,
        confirmed: true,
        expectedHash: UNCHECKED_HASH,
      });
    const refusal = async (
      content: Record<string, unknown>,
      status: number,
      message: RegExp,
    ) => {
      const response = await refused(content);
      expect(response.status, JSON.stringify(content)).toBe(status);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringMatching(message) },
      });
    };
    for (const path of [
      "../outside",
      "/etc/passwd",
      "C:\\outside",
      "safe/../../outside",
      "scripts/CON",
      "scripts/name.\u0000sh",
      "scripts/lone\ud800surrogate.sh",
    ]) {
      expect(
        (
          await refused({
            files: [file("SKILL.md", SKILL_MD), file(path, "x")],
          })
        ).status,
        path,
      ).toBe(400);
    }
    // Backslashes are refused, not read as separators.
    await refusal(
      {
        files: [
          file("example\\SKILL.md", SKILL_MD),
          file("example\\config/settings.json", "{}\n"),
        ],
      },
      400,
      /backslashes/u,
    );
    // Each segment fits a file name; the whole path stays under 1024 bytes.
    await refusal(
      { files: [file("SKILL.md", SKILL_MD), file("a".repeat(256), "x")] },
      400,
      /255 bytes/u,
    );
    await previewOf(skillId, {
      files: [file("SKILL.md", SKILL_MD), file("a".repeat(255), "x")],
    });
    // Names stay byte-exact, so names a file system would merge collide.
    for (const [left, right] of [
      ["README.md", "readme.md"],
      ["caf\u00e9.md", "cafe\u0301.md"],
      ["a/./b", "a/b"],
    ] as const)
      await refusal(
        {
          files: [
            file("SKILL.md", SKILL_MD),
            file(left, "1"),
            file(right, "2"),
          ],
        },
        400,
        /collide/u,
      );
    for (const files of [
      [
        file("SKILL.md", SKILL_MD),
        {
          path: "scripts/link",
          content: "",
          type: "symlink",
          target: "../../outside",
        },
      ],
      [
        file("SKILL.md", SKILL_MD),
        file("a", "file"),
        file("a/b", "not a directory"),
      ],
      [{ path: "SKILL.md", content: "not base64!" }],
      [file("SKILL.md", "No frontmatter")],
    ]) {
      expect((await refused({ files })).status).toBe(400);
    }
    await refusal({ files: [] }, 400, /at least one file/u);
    await refusal({ archive: zip([]) }, 400, /at least one file/u);
    const archives = [
      "UEsDBBQAAAAIAAAAIQCOsOglCAAAAAYAAAANAAAALi4vZXNjYXBlLnR4dEstTk4sSAUAUEsBAhQDFAAAAAgAAAAhAI6w6CUIAAAABgAAAA0AAAAAAAAAAAAAAIABAAAAAC4uL2VzY2FwZS50eHRQSwUGAAAAAAEAAQA7AAAAMwAAAAAA",
      "UEsDBBQAAAAIAAAAIQBASv+xDwAAAA0AAAAMAAAAc2NyaXB0cy9saW5r09PT19PTzy8tKc5MSQUAUEsBAhQDFAAAAAgAAAAhAEBK/7EPAAAADQAAAAwAAAAAAAAAAAAAAP+hAAAAAHNjcmlwdHMvbGlua1BLBQYAAAAAAQABADoAAAA5AAAAAAA=",
    ];
    for (const archive of archives)
      expect((await refused({ archive })).status).toBe(400);
    const expanded =
      "UEsDBBQAAAAIAAAAIQDPNFJvEQAAAAAIAAAIAAAAU0tJTEwubWSrqBgFo2AUjIJRMApGwUgDAFBLAQIUAxQAAAAIAAAAIQDPNFJvEQAAAAAIAAAIAAAAAAAAAAAAAACAAQAAAABTS0lMTC5tZFBLBQYAAAAAAQABADYAAAA3AAAAAAA=";
    expect((await refused({ archive: expanded })).status).toBe(413);
    expect(
      (
        await refused({
          files: [file("SKILL.md", SKILL_MD), file("large", "x".repeat(513))],
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await refused({
          files: [
            file("SKILL.md", SKILL_MD),
            file("a", "x".repeat(500)),
            file("b", "x".repeat(500)),
          ],
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await refused({
          files: Array.from({ length: 5 }, (_, index) =>
            file(String(index), ""),
          ),
        })
      ).status,
    ).toBe(413);
    const normalized = await upload(skillId, {
      files: [
        file("example/SKILL.md", SKILL_MD),
        file("example//config/./settings.json", "{}\n"),
      ],
    });
    expect(normalized.status).toBe(201);
    const versions = await service.request(endpoint, { as: administrator });
    expect(await versions.json()).toMatchObject({
      versions: [
        { inventory: [{ path: "SKILL.md" }, { path: "config/settings.json" }] },
      ],
    });
    const audit = await service.request(
      "/api/v1/audit-events?action=skill_version.uploaded",
      { as: administrator },
    );
    expect(((await audit.json()) as { events: unknown[] }).events).toHaveLength(
      1,
    );
  });

  it("keeps names byte-exact, so a version hashes as the kernel hashes the original tree", async () => {
    const { skillId } = await startLibrary();
    // Decomposed (NFD), as macOS tools often write accented names.
    const decomposed = "references/cafe\u0301.md";
    const response = await upload(skillId, {
      files: [file("SKILL.md", SKILL_MD), file(decomposed, "accent\n")],
    });
    expect(response.status).toBe(201);
    const { version } = (await response.json()) as {
      version: { hash: string; inventory: { path: string }[] };
    };
    // The kernel's hashSkillSource of that tree as written on disk.
    expect(version.hash).toBe(
      "711ca0135e59fa1cec18720606bb1b62a761582f4e68f2308878e00345c37033",
    );
    expect(version.inventory.map((entry) => entry.path)).toEqual([
      "SKILL.md",
      decomposed,
    ]);
    const composed = await upload(skillId, {
      files: [
        file("SKILL.md", SKILL_MD),
        file(decomposed.normalize("NFC"), "accent\n"),
      ],
    });
    expect(composed.status).toBe(201);
    const { version: other } = (await composed.json()) as {
      version: { hash: string };
    };
    expect(other.hash).not.toBe(version.hash);
  });

  it("drops macOS metadata from a zip and reads each entry name exactly as UTF-8", async () => {
    const { skillId } = await startLibrary();
    const plain = await previewOf(skillId, {
      files: [file("SKILL.md", SKILL_MD)],
    });
    // What Finder's Compress makes of an "example" folder.
    const finder = zip([
      { name: "example/", directory: true },
      { name: "example/SKILL.md", data: SKILL_MD },
      { name: "__MACOSX/", directory: true },
      { name: "__MACOSX/example/", directory: true },
      { name: "__MACOSX/example/._SKILL.md", data: "\u0000\u0005\u0016\u0007" },
    ]);
    expect(await previewOf(skillId, { archive: finder })).toMatchObject({
      hash: plain.hash,
      inventory: [{ path: "SKILL.md" }],
    });
    const preview = (archive: string) =>
      write(`/api/v1/skills/${skillId}/upload-preview`, { archive });
    const named = "references/\u4e2d\u6587.md";
    // The same name in GBK, as Chinese Windows tools write it.
    const gbk = Buffer.concat([
      Buffer.from("references/"),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from(".md"),
    ]);
    const flagged = await previewOf(skillId, {
      archive: zip([
        { name: "SKILL.md", data: SKILL_MD },
        { name: named, data: "x" },
      ]),
    });
    expect(flagged.inventory.map((entry) => entry.path)).toEqual([
      "SKILL.md",
      named,
    ]);
    const mapped = await previewOf(skillId, {
      archive: zip([
        { name: "SKILL.md", data: SKILL_MD },
        { name: gbk, data: "x", flags: 0, extra: unicodePath(gbk, named) },
      ]),
    });
    expect(mapped.hash).toBe(flagged.hash);
    const legacy = await preview(
      zip([
        { name: "SKILL.md", data: SKILL_MD },
        { name: gbk, data: "x", flags: 0 },
      ]),
    );
    expect(legacy.status).toBe(400);
    expect(await legacy.json()).toMatchObject({
      error: { message: expect.stringContaining("UTF-8 names") },
    });
    for (const name of [
      Buffer.from([0x66, 0xff, 0x2e, 0x6d, 0x64]),
      "scripts\\run.sh",
    ]) {
      const response = await preview(
        zip([
          { name: "SKILL.md", data: SKILL_MD },
          { name, data: "x" },
        ]),
      );
      expect(response.status, String(name)).toBe(400);
    }
  });

  it("replaces a torn blob already at its address instead of trusting it", async () => {
    const { skillId } = await startLibrary();
    const content = "reference text\n";
    const hash = createHash("sha256").update(content).digest("hex");
    // The filesystem store keeps a blob at <first two hex>/<the rest>.
    const blob = path.join(
      service.config.storage.blobDirectory,
      hash.slice(0, 2),
      hash.slice(2),
    );
    await fs.mkdir(path.dirname(blob), { recursive: true });
    // An empty file is what a crash can leave of an unsynced write.
    await fs.writeFile(blob, "");
    const response = await upload(skillId, {
      files: [file("SKILL.md", SKILL_MD), file("reference/a.md", content)],
    });
    expect(response.status).toBe(201);
    const { version } = (await response.json()) as {
      version: { hash: string };
    };
    const preview = await service.request(
      `${versionsPath(skillId)}/${version.hash}/files?path=reference%2Fa.md`,
      { as: administrator },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ content });
    expect(await fs.readFile(blob, "utf8")).toBe(content);
  });

  it("sizes the JSON envelope to the base64 of the byte limit", async () => {
    const { skillId } = await startLibrary({
      BADGER_UPLOAD_MAX_BYTES: "30000",
      BADGER_UPLOAD_MAX_FILE_BYTES: "30000",
      BADGER_UPLOAD_MAX_FILES: "2",
    });
    const largest = await upload(skillId, {
      files: [
        file("SKILL.md", SKILL_MD),
        file("reference/full.txt", "x".repeat(30000 - SKILL_MD.length)),
      ],
    });
    expect(largest.status).toBe(201);
    // Base64 of 30000 bytes, two files' path and key allowance, a constant.
    const envelope = Math.ceil(30000 / 3) * 4 + 2 * (2 * 1024 + 128) + 4096;
    const oversized = await write(`/api/v1/skills/${skillId}/upload-preview`, {
      files: [file("SKILL.md", SKILL_MD)],
      padding: "x".repeat(envelope),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { message: `The request body is limited to ${envelope} bytes` },
    });
  });

  it("answers unserved methods with 405 and an oversized Skill entry with 413", async () => {
    const { groupId, skillId } = await startLibrary();
    for (const method of ["GET", "HEAD"]) {
      const response = await service.request(
        `/api/v1/skills/${skillId}/upload-preview`,
        { method, as: administrator },
      );
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("POST");
    }
    const oversized = await write("/api/v1/skills", {
      groupId,
      name: "oversized",
      padding: "x".repeat(20000),
    });
    expect(oversized.status).toBe(413);
  });

  it("keeps the workflow capability matrix and neighboring groups separate", async () => {
    const { groupId, skillId } = await startLibrary();
    const contributor: TestPerson = {
      subject: "contributor",
      email: "contributor@example.com",
      displayName: "Contributor",
    };
    // Signed in first, so each binding resolves to them as it is made.
    await service.request("/api/v1/me", { as: contributor });
    const workflow = await createWorkflow(groupId, "capability-check");
    for (const role of [
      "Workflow owner",
      "Engineer",
      "Field expert",
      "Operator",
      "Observer",
    ]) {
      const binding = await assignWorkflowRole(workflow.id, contributor, role);
      const canUpload = ["Engineer", "Field expert"].includes(role);
      const confirmed = await confirmation(skillId, {
        files: [file("SKILL.md", `${SKILL_MD}\n${role}\n`)],
      });
      const uploaded = await write(
        versionsPath(skillId),
        confirmed,
        contributor,
      );
      expect(uploaded.status, role).toBe(canUpload ? 201 : 403);
      const skill = await write(
        "/api/v1/skills",
        {
          groupId,
          name: `contribution-${role.toLowerCase().replaceAll(" ", "-")}`,
        },
        contributor,
      );
      expect(skill.status, role).toBe(canUpload ? 201 : 403);
      const read = await service.request(versionsPath(skillId), {
        as: contributor,
      });
      expect(read.status, role).toBe(200);
      expect((await removeBinding(binding)).status, role).toBe(200);
    }
    const outsiders = await service.request("/api/v1/skills", {
      as: contributor,
    });
    expect(await outsiders.json()).toMatchObject({ skills: [], groups: [] });
    const unauthorized = await write(
      "/api/v1/bindings",
      {
        scopeType: "workflow",
        scopeId: workflow.id,
        email: contributor.email,
        role: "Engineer",
      },
      contributor,
    );
    expect(unauthorized.status).toBe(403);
    const malformed = await service.request("/api/v1/skills/%ZZ", {
      as: administrator,
    });
    expect(malformed.status).toBe(400);
    const badRoute = await service.request(
      `/api/v1/skills/${skillId}/diff/arbitrary`,
      { as: administrator },
    );
    expect(badRoute.status).toBe(404);
  });

  it("deduplicates concurrent uploads, binds confirmation to the previewed hash, and caps or escapes previews without serving uploaded markup", async () => {
    const { skillId } = await startLibrary();
    const content = {
      files: [
        file("SKILL.md", SKILL_MD),
        file("unsafe.html", "<script>alert('never execute')</script>"),
        file("binary.bin", "\u0000binary"),
        file("large.txt", "x".repeat(256 * 1024 + 1)),
      ],
    };
    const input = await confirmation(skillId, content);
    const responses = await Promise.all([
      write(versionsPath(skillId), input),
      write(versionsPath(skillId), input),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    const { version } = (await responses[0]!.json()) as {
      version: { hash: string };
    };
    const preview = (path: string) =>
      service.request(
        `${versionsPath(skillId)}/${version.hash}/files?${new URLSearchParams({ path })}`,
        { as: administrator },
      );
    const markup = await preview("unsafe.html");
    expect(markup.headers.get("content-type")).toContain("application/json");
    expect(await markup.json()).toMatchObject({
      content: "<script>alert('never execute')</script>",
      binary: false,
    });
    expect(await (await preview("binary.bin")).json()).toMatchObject({
      binary: true,
      content: null,
    });
    expect(await (await preview("large.txt")).json()).toMatchObject({
      tooLarge: true,
      content: null,
    });
    expect((await preview("../unsafe.html")).status).toBe(404);
    const drift = await write(versionsPath(skillId), {
      ...input,
      expectedHash: UNCHECKED_HASH,
    });
    expect(drift.status).toBe(409);
    expect(await drift.json()).toMatchObject({
      error: { code: "conflict" },
      hash: version.hash,
    });
    for (const expectedHash of [undefined, "abc", version.hash.toUpperCase()]) {
      const unbound = await write(versionsPath(skillId), {
        ...content,
        confirmed: true,
        expectedHash,
      });
      expect(unbound.status, String(expectedHash)).toBe(400);
    }
    const audit = await service.request(
      "/api/v1/audit-events?action=skill_version.uploaded",
      { as: administrator },
    );
    expect(((await audit.json()) as { events: unknown[] }).events).toHaveLength(
      1,
    );
  });
});
