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
  it("keeps a kernel-identified immutable version, its full inventory, and safe previews", async () => {
    const { skillId } = await startLibrary();
    const response = await write(`/api/v1/skills/${skillId}/versions`, {
      confirmed: true,
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
    const duplicate = await write(`/api/v1/skills/${skillId}/versions`, {
      confirmed: true,
      files: [
        file("example/config/settings.json", "{}\n"),
        file("example/SKILL.md", SKILL_MD),
        file("example/.DS_Store", "desktop noise"),
      ],
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ version });
    const versions = await service.request(
      `/api/v1/skills/${skillId}/versions`,
      {
        as: administrator,
      },
    );
    expect(await versions.json()).toMatchObject({ versions: [version] });
    const preview = await service.request(
      `/api/v1/skills/${skillId}/versions/${version.hash}/files?path=config%2Fsettings.json`,
      { as: administrator },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      content: "{}\n",
      binary: false,
    });
    const update = await service.request(
      `/api/v1/skills/${skillId}/versions/${version.hash}`,
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

  it("uploads a zip without running scripts and binds their side effects immutably", async () => {
    const { skillId } = await startLibrary();
    const archive =
      "UEsDBBQAAAAIAFCKXF0XQtDYMgAAADwAAAAQAAAAZXhhbXBsZS9TS0lMTC5tZNPV1eXKS8xNtVJIrUjMLchJ5UpJLU4uyiwoyczPs1JwhQgqBGdn5uRw6QIVcynDBLkAUEsDBBQAAAAIAFCKXF2L+KIZHQAAABsAAAAWAAAAZXhhbXBsZS9zY3JpcHRzL3J1bi5zaFNW1E/KzNMvzuAqKMrMK0lTyEstSy3SLSrN4wIAUEsBAhQDFAAAAAgAUIpcXRdC0NgyAAAAPAAAABAAAAAAAAAAAAAAAIABAAAAAGV4YW1wbGUvU0tJTEwubWRQSwECFAMUAAAACABQilxdi/iiGR0AAAAbAAAAFgAAAAAAAAAAAAAAgAFgAAAAZXhhbXBsZS9zY3JpcHRzL3J1bi5zaFBLBQYAAAAAAgACAIIAAACxAAAAAAA=";
    const response = await write(`/api/v1/skills/${skillId}/versions`, {
      confirmed: true,
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
    const duplicate = await write(`/api/v1/skills/${skillId}/versions`, {
      confirmed: true,
      files: [
        file("SKILL.md", SKILL_MD),
        file("scripts/run.sh", "#!/bin/sh\nprintf never-run\n"),
      ],
      scripts: { "scripts/run.sh": ["network", "local-writes"] },
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ version });
    const conflicting = await write(`/api/v1/skills/${skillId}/versions`, {
      confirmed: true,
      archive,
      scripts: { "scripts/run.sh": "none" },
    });
    expect(conflicting.status).toBe(409);
    const invalid = await write(`/api/v1/skills/${skillId}/versions`, {
      confirmed: true,
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
    const upload = { confirmed: true, files: [file("SKILL.md", SKILL_MD)] };
    expect(
      (await write(`/api/v1/skills/${skillId}/versions`, upload, expert))
        .status,
    ).toBe(404);
    const binding = await assignWorkflowRole(
      workflow.id,
      expert,
      "Field expert",
    );
    const uploaded = await write(
      `/api/v1/skills/${skillId}/versions`,
      upload,
      expert,
    );
    expect(uploaded.status).toBe(201);
    const catalog = await service.request("/api/v1/skills", { as: expert });
    expect(await catalog.json()).toMatchObject({
      skills: [{ id: skillId, canUpload: true }],
    });
    expect((await removeBinding(binding)).status).toBe(200);
    expect(
      (await write(`/api/v1/skills/${skillId}/versions`, upload, expert))
        .status,
    ).toBe(404);
  });

  it("previews before confirmation and compares any two versions without losing old files", async () => {
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
    const before = await service.request(`/api/v1/skills/${skillId}/versions`, {
      as: administrator,
    });
    expect(await before.json()).toEqual({ versions: [] });
    expect(
      (await write(`/api/v1/skills/${skillId}/versions`, first)).status,
    ).toBe(400);
    const created = await write(`/api/v1/skills/${skillId}/versions`, {
      ...first,
      confirmed: true,
    });
    const { version: original } = (await created.json()) as {
      version: { hash: string };
    };
    const second = await write(`/api/v1/skills/${skillId}/versions`, {
      confirmed: true,
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
        { path: "scripts/run.sh", before: "undeclared", after: ["none"] },
      ],
    });
    const old = await service.request(
      `/api/v1/skills/${skillId}/versions/${original.hash}/files?path=reference/old.md`,
      { as: administrator },
    );
    expect(await old.json()).toMatchObject({ content: "old\n" });
  });

  it("refuses escaping paths, links, malformed files, and expanded uploads over their limits", async () => {
    const { skillId } = await startLibrary({
      BADGER_UPLOAD_MAX_BYTES: "1024",
      BADGER_UPLOAD_MAX_FILE_BYTES: "512",
      BADGER_UPLOAD_MAX_FILES: "4",
    });
    const endpoint = `/api/v1/skills/${skillId}/versions`;
    for (const path of [
      "../outside",
      "/etc/passwd",
      "C:\\outside",
      "safe/../../outside",
      "scripts/CON",
      "scripts/name.\u0000sh",
    ]) {
      expect(
        (
          await write(endpoint, {
            confirmed: true,
            files: [file("SKILL.md", SKILL_MD), file(path, "refused")],
          })
        ).status,
        path,
      ).toBe(400);
    }
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
        file("a/./b", "first"),
        file("a/b", "duplicate"),
      ],
      [
        file("SKILL.md", SKILL_MD),
        file("a", "file"),
        file("a/b", "not a directory"),
      ],
      [{ path: "SKILL.md", content: "not base64!" }],
      [file("SKILL.md", "No frontmatter")],
    ]) {
      expect((await write(endpoint, { confirmed: true, files })).status).toBe(
        400,
      );
    }
    const archives = [
      "UEsDBBQAAAAIAAAAIQCOsOglCAAAAAYAAAANAAAALi4vZXNjYXBlLnR4dEstTk4sSAUAUEsBAhQDFAAAAAgAAAAhAI6w6CUIAAAABgAAAA0AAAAAAAAAAAAAAIABAAAAAC4uL2VzY2FwZS50eHRQSwUGAAAAAAEAAQA7AAAAMwAAAAAA",
      "UEsDBBQAAAAIAAAAIQBASv+xDwAAAA0AAAAMAAAAc2NyaXB0cy9saW5r09PT19PTzy8tKc5MSQUAUEsBAhQDFAAAAAgAAAAhAEBK/7EPAAAADQAAAAwAAAAAAAAAAAAAAP+hAAAAAHNjcmlwdHMvbGlua1BLBQYAAAAAAQABADoAAAA5AAAAAAA=",
    ];
    for (const archive of archives)
      expect((await write(endpoint, { confirmed: true, archive })).status).toBe(
        400,
      );
    const expanded =
      "UEsDBBQAAAAIAAAAIQDPNFJvEQAAAAAIAAAIAAAAU0tJTEwubWSrqBgFo2AUjIJRMApGwUgDAFBLAQIUAxQAAAAIAAAAIQDPNFJvEQAAAAAIAAAIAAAAAAAAAAAAAACAAQAAAABTS0lMTC5tZFBLBQYAAAAAAQABADYAAAA3AAAAAAA=";
    expect(
      (await write(endpoint, { confirmed: true, archive: expanded })).status,
    ).toBe(413);
    expect(
      (
        await write(endpoint, {
          confirmed: true,
          files: [file("SKILL.md", SKILL_MD), file("large", "x".repeat(513))],
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await write(endpoint, {
          confirmed: true,
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
        await write(endpoint, {
          confirmed: true,
          files: Array.from({ length: 5 }, (_, index) =>
            file(String(index), ""),
          ),
        })
      ).status,
    ).toBe(413);
    const normalized = await write(endpoint, {
      confirmed: true,
      files: [
        file("example\\SKILL.md", SKILL_MD),
        file("example\\config/./settings.json", "{}\n"),
      ],
    });
    expect(normalized.status).toBe(201);
    const versions = await service.request(
      `/api/v1/skills/${skillId}/versions`,
      { as: administrator },
    );
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
      "Reviewer",
      "Operator",
      "Observer",
    ]) {
      const binding = await assignWorkflowRole(workflow.id, contributor, role);
      const canUpload = ["Engineer", "Field expert"].includes(role);
      const upload = await write(
        `/api/v1/skills/${skillId}/versions`,
        {
          confirmed: true,
          files: [file("SKILL.md", `${SKILL_MD}\n${role}\n`)],
        },
        contributor,
      );
      expect(upload.status, role).toBe(canUpload ? 201 : 403);
      const skill = await write(
        "/api/v1/skills",
        {
          groupId,
          name: `contribution-${role.toLowerCase().replaceAll(" ", "-")}`,
        },
        contributor,
      );
      expect(skill.status, role).toBe(canUpload ? 201 : 403);
      const read = await service.request(`/api/v1/skills/${skillId}/versions`, {
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

  it("deduplicates concurrent uploads and caps or escapes previews without serving uploaded markup", async () => {
    const { skillId } = await startLibrary();
    const input = {
      confirmed: true,
      files: [
        file("SKILL.md", SKILL_MD),
        file("unsafe.html", "<script>alert('never execute')</script>"),
        file("binary.bin", "\u0000binary"),
        file("large.txt", "x".repeat(256 * 1024 + 1)),
      ],
    };
    const responses = await Promise.all([
      write(`/api/v1/skills/${skillId}/versions`, input),
      write(`/api/v1/skills/${skillId}/versions`, input),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    const { version } = (await responses[0]!.json()) as {
      version: { hash: string };
    };
    const preview = (path: string) =>
      service.request(
        `/api/v1/skills/${skillId}/versions/${version.hash}/files?${new URLSearchParams({ path })}`,
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
    const drift = await write(`/api/v1/skills/${skillId}/versions`, {
      ...input,
      expectedHash: "0".repeat(64),
    });
    expect(drift.status).toBe(409);
    const audit = await service.request(
      "/api/v1/audit-events?action=skill_version.uploaded",
      { as: administrator },
    );
    expect(((await audit.json()) as { events: unknown[] }).events).toHaveLength(
      1,
    );
  });
});
