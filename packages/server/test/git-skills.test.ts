import { afterEach, describe, expect, it } from "vitest";
import {
  startStubGitRepository,
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

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
) {
  remote = await startStubGitRepository(files);
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

describe("Skill versions from registered Git repositories", () => {
  it("imports the exact committed tree with upload identity and durable Git provenance", async () => {
    const { base } = await library();
    const registered = await write(`${base}/repositories`, { url: remote.url });
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
  });
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

  it("keeps script declarations immutable and never runs committed scripts or Git export filters", async () => {
    const files = {
      ...FILES,
      "scripts/run.sh": "#!/bin/sh\nexit 91\n",
      ".gitattributes":
        "config/settings.json export-ignore\nSKILL.md export-subst\n",
      ".DS_Store": "host noise",
    };
    const { base: target } = await library(files);
    const { repository } = (await (
      await write(`${target}/repositories`, { url: remote.url })
    ).json()) as { repository: { id: string } };
    const input = { repositoryId: repository.id, commit: remote.commit };
    const preview = await write(`${target}/git-preview`, input);
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
      "SKILL.md",
      "config/settings.json",
      "scripts/run.sh",
    ]);
    const confirmation = {
      ...input,
      confirmed: true,
      expectedHash: inspected.hash,
    };
    expect((await write(`${target}/versions`, confirmation)).status).toBe(400);
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
  });

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

  it("times out an unresponsive Git server", async () => {
    const { base } = await library(FILES, { BADGER_GIT_TIMEOUT_MS: "200" });
    const { repository } = (await (
      await write(`${base}/repositories`, { url: remote.url })
    ).json()) as { repository: { id: string } };
    remote.stall();
    expect(
      (
        await write(`${base}/git-preview`, {
          repositoryId: repository.id,
          commit: remote.commit,
        })
      ).status,
    ).toBe(400);
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
