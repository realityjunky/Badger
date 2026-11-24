import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { fromBufferPromise } from "yauzl";
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
  it("requires a Group lead for removal and preserves referenced versions and shared blobs", async () => {
    const { skillId, groupId } = await startLibrary();
    const lead = { subject: "lead", email: "lead@example.com" };
    const member = { subject: "member", email: "member@example.com" };
    for (const [person, role] of [
      [lead, "Group lead"],
      [member, "Member"],
    ] as const) {
      expect(
        (
          await write("/api/v1/bindings", {
            scopeType: "group",
            scopeId: groupId,
            email: person.email,
            role,
          })
        ).status,
      ).toBe(201);
    }
    const { version: original } = await (
      await upload(skillId, { files: [file("SKILL.md", SKILL_MD)] })
    ).json();
    const { version: successor } = await (
      await upload(skillId, {
        baseHash: original.hash,
        files: [
          file("SKILL.md", SKILL_MD),
          file("guide.md", "retained guidance"),
        ],
      })
    ).json();
    const { version: unused } = await (
      await upload(skillId, {
        files: [
          file("SKILL.md", SKILL_MD),
          file("guide.md", "abandoned guidance"),
        ],
      })
    ).json();
    const versions = versionsPath(skillId);
    const originalPath = `${versions}/${original.hash}`;
    const unusedPath = `${versions}/${unused.hash}`;
    expect(
      (
        await write(
          `${originalPath}/label`,
          { label: "1.0.0", revision: 0 },
          member,
          "PATCH",
        )
      ).status,
    ).toBe(403);
    expect(
      (await write(unusedPath, { action: "delete" }, member, "DELETE")).status,
    ).toBe(403);
    const available = await service.request(`${unusedPath}/removal`, {
      as: lead,
    });
    expect(await available.json()).toEqual({
      action: "delete",
      referenced: false,
    });
    const deleted = await write(
      unusedPath,
      { action: "delete" },
      lead,
      "DELETE",
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ action: "delete", version: null });
    expect((await service.request(unusedPath, { as: member })).status).toBe(
      404,
    );
    const referenced = await service.request(`${originalPath}/removal`, {
      as: lead,
    });
    expect(await referenced.json()).toEqual({
      action: "retire",
      referenced: true,
    });
    const stale = await write(
      originalPath,
      { action: "delete" },
      lead,
      "DELETE",
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      removal: { action: "retire", referenced: true },
    });
    const retired = await write(
      originalPath,
      { action: "retire" },
      lead,
      "DELETE",
    );
    expect(retired.status).toBe(200);
    expect(await retired.json()).toMatchObject({
      action: "retire",
      version: { ...original, retiredAt: expect.any(String) },
    });
    const replay = await write(
      originalPath,
      { action: "retire" },
      lead,
      "DELETE",
    );
    expect(replay.status).toBe(200);
    const history = await service.request(versions, { as: member });
    expect(await history.json()).toMatchObject({
      versions: expect.arrayContaining([
        { ...original, retiredAt: expect.any(String) },
        successor,
      ]),
    });
    const shared = await service.request(
      `${originalPath}/files?path=SKILL.md`,
      { as: member },
    );
    expect(await shared.json()).toMatchObject({ content: SKILL_MD });
  });

  it("reviews browser and local edits against the explicitly selected version and deduplicates their content", async () => {
    const { skillId } = await startLibrary();
    const versions = versionsPath(skillId);
    const initialFiles = [
      file("SKILL.md", SKILL_MD),
      file("reference/old.md", "old"),
      file("assets/image.bin", "\u0000original"),
    ];
    const { version: base } = await (
      await upload(skillId, { files: initialFiles })
    ).json();
    const { version: newer } = await (
      await upload(skillId, {
        files: [file("SKILL.md", `${SKILL_MD}\nNewer version\n`)],
      })
    ).json();
    const browserEdit = {
      baseHash: base.hash,
      changes: [
        file("assets/image.bin", "\u0000replacement"),
        { path: "reference/old.md", content: null },
        file("reference/new.md", "new"),
      ],
    };
    const previewPath = `/api/v1/skills/${skillId}/upload-preview`;
    const response = await write(previewPath, browserEdit);
    expect(response.status).toBe(200);
    const { preview, diff } = await response.json();
    expect(diff).toMatchObject({
      from: base.hash,
      to: preview.hash,
      files: [
        { path: "assets/image.bin", status: "modified" },
        { path: "reference/new.md", status: "added" },
        { path: "reference/old.md", status: "removed" },
      ],
    });
    expect(preview.hash).not.toBe(newer.hash);
    expect((await write(versions, browserEdit)).status).toBe(400);
    const confirmation = {
      ...browserEdit,
      confirmed: true,
      expectedHash: preview.hash,
    };
    expect(
      (await write(versions, { ...confirmation, expectedHash: newer.hash }))
        .status,
    ).toBe(409);
    const saved = await write(versions, confirmation);
    expect(saved.status).toBe(201);
    const { version } = await saved.json();
    expect(version).toMatchObject({
      hash: preview.hash,
      origin: "edit",
      editOrigins: [
        {
          baseHash: base.hash,
          method: "browser",
          editedBy: version.uploadedBy,
        },
      ],
    });
    const retry = await write(versions, confirmation);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ version });
    const localEdit = {
      baseHash: base.hash,
      archive: zip([
        { name: "example/SKILL.md", data: SKILL_MD },
        { name: "example/assets/image.bin", data: "\u0000replacement" },
        { name: "example/reference/new.md", data: "new" },
      ]),
    };
    const localPreview = await write(previewPath, localEdit);
    expect(localPreview.status).toBe(200);
    expect(await localPreview.json()).toMatchObject({
      preview: { hash: version.hash },
      diff,
    });
    const confirmedLocally = await write(versions, {
      ...localEdit,
      confirmed: true,
      expectedHash: version.hash,
    });
    expect(confirmedLocally.status).toBe(200);
    expect(await confirmedLocally.json()).toMatchObject({
      version: {
        ...version,
        editOrigins: [
          { baseHash: base.hash, method: "browser" },
          { baseHash: base.hash, method: "upload" },
        ],
      },
    });
    const original = await service.request(`${versions}/${base.hash}`, {
      as: administrator,
    });
    expect(await original.json()).toEqual({ version: base });
    const missingBase = await write(previewPath, {
      ...browserEdit,
      baseHash: UNCHECKED_HASH,
    });
    expect(missingBase.status).toBe(404);
    const unavailablePath = await write(previewPath, {
      ...browserEdit,
      changes: [file("../escaped", "fail")],
    });
    expect(unavailablePath.status).toBe(400);
    const invalidBytes = await write(previewPath, {
      ...browserEdit,
      changes: [{ path: "assets/image.bin", content: "AB==" }],
    });
    expect(invalidBytes.status).toBe(400);
  });

  it("lets a Group member download the exact nested and binary files of a selected version", async () => {
    const { skillId, groupId } = await startLibrary();
    const member = { subject: "member", email: "member@example.com" };
    expect(
      (
        await write("/api/v1/bindings", {
          scopeType: "group",
          scopeId: groupId,
          email: member.email,
          role: "Member",
        })
      ).status,
    ).toBe(201);
    const binary = Buffer.from([0x00, 0xff, 0x8f, 0x00, 0x90]);
    const uploaded = await upload(skillId, {
      files: [
        file("SKILL.md", SKILL_MD),
        { path: "assets/数据/fixture.bin", content: binary.toString("base64") },
      ],
    });
    expect(uploaded.status).toBe(201);
    const { version } = await uploaded.json();
    const url = `${versionsPath(skillId)}/${version.hash}/download`;
    const response = await service.request(url, { as: member });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment;.*\.zip"$/u,
    );
    const zip = Buffer.from(await response.arrayBuffer());
    const archive = await fromBufferPromise(zip);
    const downloaded = new Map<string, Buffer>();
    try {
      for await (const entry of archive.eachEntry()) {
        const chunks = [];
        for await (const chunk of await archive.openReadStreamPromise(entry))
          chunks.push(Buffer.from(chunk as Uint8Array));
        downloaded.set(entry.fileName, Buffer.concat(chunks));
      }
    } finally {
      archive.close();
    }
    expect([...downloaded]).toEqual([
      ["SKILL.md", Buffer.from(SKILL_MD)],
      ["assets/数据/fixture.bin", binary],
    ]);
    expect(
      (await upload(skillId, { archive: zip.toString("base64") })).status,
    ).toBe(200);
    const outsider = { subject: "outsider", email: "outsider@example.com" };
    expect((await service.request(url, { as: outsider })).status).toBe(404);
  });

  it("numbers immutable versions with an audited label correction and rejects conflicting writes", async () => {
    const { skillId } = await startLibrary();
    const versions = versionsPath(skillId);
    const first = await upload(skillId, {
      files: [file("SKILL.md", SKILL_MD)],
    });
    const second = await upload(skillId, {
      files: [file("SKILL.md", `${SKILL_MD}\nNew use case\n`)],
    });
    const { version: original } = await first.json();
    const { version: candidate } = await second.json();
    expect(original).toMatchObject({ label: null, labelRevision: 0 });
    const update = (hash: string, label: string, revision: number) =>
      write(
        `${versions}/${hash}/label`,
        { label, revision },
        administrator,
        "PATCH",
      );
    expect((await update(original.hash, "1.01.0", 0)).status).toBe(400);
    const competing = await Promise.all([
      update(original.hash, "1.0.0", 0),
      update(candidate.hash, "1.0.0", 0),
    ]);
    expect(
      competing.map((response) => response.status).sort(),
      JSON.stringify(service.logs.filter(({ level }) => level === "error")),
    ).toEqual([200, 409]);
    const { version: labelled } = await competing
      .find((response) => response.ok)!
      .json();
    const corrected = await update(labelled.hash, "1.0.1", 1);
    expect(corrected.status).toBe(200);
    expect((await update(labelled.hash, "2.0.0", 1)).status).toBe(409);
    const unchanged = await service.request(`${versions}/${labelled.hash}`, {
      as: administrator,
    });
    expect(await unchanged.json()).toMatchObject({
      version: { ...labelled, label: "1.0.1", labelRevision: 2 },
    });
    const audit = await service.request(
      "/api/v1/audit-events?action=skill_version.label_updated",
      { as: administrator },
    );
    expect(await audit.json()).toMatchObject({
      events: [
        {
          before: { hash: labelled.hash, revision: 1 },
          after: { hash: labelled.hash, revision: 2 },
        },
        {
          before: { hash: labelled.hash, revision: null },
          after: { hash: labelled.hash, revision: 1 },
        },
      ],
    });
  });

  it("uploads scripts with pending effect review and preserves the first uploader on deduplication", async () => {
    const { skillId, groupId } = await startLibrary();
    const files = [
      file("SKILL.md", SKILL_MD),
      file("scripts/run.sh", "#!/bin/sh\nprintf 'study only'\n"),
    ];
    const preview = await previewOf(skillId, { files });
    const response = await write(versionsPath(skillId), {
      files,
      confirmed: true,
      expectedHash: preview.hash,
    });
    expect(response.status).toBe(201);
    const { version } = await response.json();
    expect(version.scripts).toEqual([
      { path: "scripts/run.sh", sideEffects: "undeclared" },
    ]);
    const other: TestPerson = { subject: "other", email: "other@example.com" };
    const workflow = await createWorkflow(groupId, "other-uploader");
    await assignWorkflowRole(workflow.id, other, "Engineer");
    const duplicate = await write(
      versionsPath(skillId),
      { files, confirmed: true, expectedHash: preview.hash },
      other,
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ version });
  });

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

  it("uploads a zip with pending effects without running scripts and deduplicates folder ingress", async () => {
    const { skillId } = await startLibrary();
    const archive =
      "UEsDBBQAAAAIAFCKXF0XQtDYMgAAADwAAAAQAAAAZXhhbXBsZS9TS0lMTC5tZNPV1eXKS8xNtVJIrUjMLchJ5UpJLU4uyiwoyczPs1JwhQgqBGdn5uRw6QIVcynDBLkAUEsDBBQAAAAIAFCKXF2L+KIZHQAAABsAAAAWAAAAZXhhbXBsZS9zY3JpcHRzL3J1bi5zaFNW1E/KzNMvzuAqKMrMK0lTyEstSy3SLSrN4wIAUEsBAhQDFAAAAAgAUIpcXRdC0NgyAAAAPAAAABAAAAAAAAAAAAAAAIABAAAAAGV4YW1wbGUvU0tJTEwubWRQSwECFAMUAAAACABQilxdi/iiGR0AAAAbAAAAFgAAAAAAAAAAAAAAgAFgAAAAZXhhbXBsZS9zY3JpcHRzL3J1bi5zaFBLBQYAAAAAAgACAIIAAACxAAAAAAA=";
    const response = await upload(skillId, {
      archive,
    });
    expect(response.status).toBe(201);
    const { version } = (await response.json()) as {
      version: { hash: string; scripts: unknown[] };
    };
    expect(version.scripts).toEqual([
      { path: "scripts/run.sh", sideEffects: "undeclared" },
    ]);
    const duplicate = await upload(skillId, {
      files: [
        file("SKILL.md", SKILL_MD),
        file("scripts/run.sh", "#!/bin/sh\nprintf never-run\n"),
      ],
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ version });
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

  it("previews before confirmation and compares file versions while effects remain pending", async () => {
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
    const created = await upload(skillId, first);
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
      scripts: [],
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
    const envelope =
      Math.ceil((30000 + 2 * (2 * 1024 + 128) + 22) / 3) * 4 + 4096;
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
