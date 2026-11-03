import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startTestService,
  startStubLlmProvider,
  startStubGitRepository,
  type TestService,
  type TestPerson,
} from "../src/testing/index.js";

const ORIGIN = "https://dashboard.example";
const administrator: TestPerson = {
  subject: "admin",
  email: "admin@example.com",
};
let service: TestService;
let provider: Awaited<ReturnType<typeof startStubLlmProvider>>;
let remote: Awaited<ReturnType<typeof startStubGitRepository>>;
let temporary: string | undefined;

afterEach(async () => {
  provider?.releaseResponses();
  await service?.close();
  await provider?.close();
  await remote?.close();
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
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

async function start(environment: Record<string, string> = {}) {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: administrator.email!,
      BADGER_ALLOWED_ORIGINS: ORIGIN,
      ...environment,
    },
  });
}

async function configuration() {
  return (
    await service.request("/api/v1/admin/llm", { as: administrator })
  ).json();
}

function model(url: string) {
  return {
    id: "flash",
    name: "DeepSeek Flash",
    provider: "deepseek",
    protocol: "litellm-chat",
    model: "deepseek-v4.1-flash",
    apiBaseUrl: url,
    secretRef: null,
    enabled: true,
    descriptors: [
      {
        key: "thinking",
        label: "Thinking",
        type: "boolean",
        default: true,
        mapping: {
          target: "thinking.type",
          values: { true: "enabled", false: "disabled" },
        },
      },
      {
        key: "effort",
        label: "Reasoning effort",
        type: "enum",
        default: "max",
        options: [
          { value: "max", label: "Max" },
          { value: "high", label: "High" },
        ],
        mapping: { target: "reasoning_effort" },
      },
      {
        key: "context",
        label: "Context budget",
        type: "integer",
        minimum: 1024,
        maximum: 1000000,
        default: 500000,
        mapping: { target: "context-budget" },
      },
      {
        key: "output",
        label: "Maximum output tokens",
        type: "integer",
        minimum: 256,
        maximum: 32768,
        default: 4096,
        mapping: { target: "max_tokens" },
      },
    ],
    settings: {},
  };
}

async function configure(url: string) {
  const current = await configuration();
  current.configuration.models = [model(url)];
  current.configuration.bindings["script-side-effects"] = "flash";
  const response = await write(
    "/api/v1/admin/llm",
    {
      revision: current.revision,
      configuration: current.configuration,
      secrets: {
        flash: { action: "replace", value: "synthetic-provider-secret-95" },
      },
    },
    administrator,
    "PUT",
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

describe("Administrator LLM configuration", () => {
  it("lets only a signed-in Organization Administrator read and save a revision", async () => {
    await start();
    const response = await service.request("/api/v1/admin/llm", {
      as: administrator,
    });
    expect(response.status).toBe(200);
    const { configuration, revision } = await response.json();
    expect(configuration.schemaVersion).toBe(1);
    expect(configuration.prompts["script-side-effects"].text).toContain(
      "{{source}}",
    );
    const saved = await write(
      "/api/v1/admin/llm",
      { revision, configuration },
      administrator,
      "PUT",
    );
    expect(saved.status).toBe(200);
    expect((await saved.json()).revision).toBe(revision + 1);
    expect(
      (
        await write(
          "/api/v1/admin/llm",
          { revision, configuration },
          administrator,
          "PUT",
        )
      ).status,
    ).toBe(409);
    const stranger = { subject: "stranger" };
    expect(
      (await service.request("/api/v1/admin/llm", { as: stranger })).status,
    ).toBe(403);
    expect(
      (
        await write(
          "/api/v1/admin/llm",
          { revision, configuration },
          stranger,
          "PUT",
        )
      ).status,
    ).toBe(403);
  });

  it("keeps API keys write-only, preserves them on normal saves and tests exact LiteLLM parameters", async () => {
    provider = await startStubLlmProvider();
    provider.requireKey("synthetic-provider-secret-95");
    await start({
      BADGER_LLM_KEY: "ab".repeat(32),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    });
    const saved = await configure(provider.url);
    expect(saved.credentials.flash.configured).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("synthetic-provider-secret-95");
    const normalSave = await write(
      "/api/v1/admin/llm",
      { revision: saved.revision, configuration: saved.configuration },
      administrator,
      "PUT",
    );
    expect(normalSave.status).toBe(200);
    const tested = await write("/api/v1/admin/llm/test", {
      modelId: "flash",
      revision: saved.revision + 1,
    });
    expect(tested.status, await tested.clone().text()).toBe(200);
    expect(provider.requests[0]).toMatchObject({
      model: "deepseek-v4.1-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 4096,
      drop_params: false,
    });
    expect(provider.requests[0]).not.toHaveProperty("context");
    expect(provider.requests[0]).not.toHaveProperty("context_budget");
    expect(JSON.stringify(service.logs)).not.toContain(
      "synthetic-provider-secret-95",
    );
    const audit = await (
      await service.request("/api/v1/audit-events", { as: administrator })
    ).text();
    expect(audit).toContain("llm_configuration.updated");
    expect(audit).not.toContain("synthetic-provider-secret-95");
  });

  it("denies Group leads, workflow roles, Auditors and personal access tokens every administration route", async () => {
    await start();
    const entry = await skill();
    const { workflow } = await (
      await write("/api/v1/workflows", {
        groupId: entry.groupId,
        name: "review",
        goal: "Study a Skill",
        intent: "new-skill",
        locale: "en",
      })
    ).json();
    for (const [subject, role, scopeType, scopeId] of [
      ["lead", "Group lead", "group", entry.groupId],
      ["engineer", "Engineer", "workflow", workflow.id],
      ["expert", "Field expert", "workflow", workflow.id],
      ["auditor", "Auditor", "organization", null],
    ]) {
      const person = { subject: subject!, email: `${subject}@example.com` };
      expect(
        (
          await write("/api/v1/bindings", {
            scopeType,
            scopeId,
            email: person.email,
            role,
          })
        ).status,
      ).toBe(201);
      expect(
        (await service.request("/api/v1/admin/llm", { as: person })).status,
      ).toBe(403);
      for (const action of ["test", "reload"])
        expect(
          (await write(`/api/v1/admin/llm/${action}`, {}, person)).status,
        ).toBe(403);
      expect((await write("/api/v1/admin/llm", {}, person, "PUT")).status).toBe(
        403,
      );
    }
    const issued = await write("/api/v1/me/tokens", {
      name: "Agent",
      scopes: ["engineer"],
    });
    expect(issued.status).toBe(201);
    const { secret } = await issued.json();
    const denied = await service.request("/api/v1/admin/llm", {
      headers: {
        authorization: `Bearer ${secret}`,
        "x-badger-agent-host": "synthetic-agent",
      },
    });
    expect(denied.status).toBe(403);
  });

  it("loads a secret-free file, persists dashboard edits across restart, and rejects stale file and UI writes", async () => {
    provider = await startStubLlmProvider();
    provider.requireKey("synthetic-restart-key-95");
    temporary = await fs.mkdtemp(path.join(tmpdir(), "badger-llm-restart-"));
    const filename = path.join(temporary, "llm.json");
    const example = JSON.parse(
      await fs.readFile(
        new URL("../config/llm.example.json", import.meta.url),
        "utf8",
      ),
    );
    example.configuration.models[0].apiBaseUrl = provider.url;
    await fs.writeFile(filename, JSON.stringify(example));
    const environment = {
      BADGER_STORAGE_DIR: path.join(temporary, "storage"),
      BADGER_DATABASE_PATH: path.join(temporary, "database"),
      BADGER_LLM_CONFIG_FILE: filename,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
      BADGER_LLM_KEY: "bc".repeat(32),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    };
    service = await startTestService({ mode: "local", environment });
    const localRead = async () =>
      (await service.request("/api/v1/admin/llm")).json();
    const localWrite = (suffix: string, body: unknown, method = "PUT") =>
      service.request(`/api/v1/admin/llm${suffix}`, {
        method,
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const initial = await localRead();
    expect(initial.configuration.models[0].model).toBe("deepseek-v4.1-flash");
    expect(initial.credentials["deepseek-v4-1-flash"].configured).toBe(false);
    initial.configuration.prompts["script-side-effects"].text +=
      "\nExplain conditional modes.";
    initial.configuration.models.push({
      ...initial.configuration.models[0],
      id: "second",
      name: "Second model",
    });
    const saved = await localWrite("", {
      revision: initial.revision,
      configuration: initial.configuration,
      secrets: {
        "deepseek-v4-1-flash": {
          action: "replace",
          value: "synthetic-restart-key-95",
        },
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const accepted = await saved.json();
    await service.close();
    service = await startTestService({ mode: "local", environment });
    expect((await localRead()).configuration).toEqual(accepted.configuration);
    expect(
      (await localRead()).credentials["deepseek-v4-1-flash"].configured,
    ).toBe(true);
    expect(
      (
        await localWrite(
          "/test",
          { revision: accepted.revision, modelId: "deepseek-v4-1-flash" },
          "POST",
        )
      ).status,
    ).toBe(200);
    expect(
      (await localWrite("/reload", { revision: accepted.revision }, "POST"))
        .status,
    ).toBe(409);
    accepted.configuration.models[1].settings = { "context-budget": 450000 };
    await fs.writeFile(
      filename,
      JSON.stringify({
        revision: accepted.revision,
        configuration: accepted.configuration,
      }),
    );
    const reloaded = await localWrite(
      "/reload",
      { revision: accepted.revision },
      "POST",
    );
    expect(reloaded.status).toBe(200);
    const current = await reloaded.json();
    expect(current.configuration.models).toHaveLength(2);
    expect(current.configuration.prompts).toEqual(
      accepted.configuration.prompts,
    );
    expect(current.configuration.models[1].settings).toEqual({
      "context-budget": 450000,
    });
    expect(
      (
        await localWrite("", {
          revision: accepted.revision,
          configuration: accepted.configuration,
        })
      ).status,
    ).toBe(409);
    await fs.writeFile(
      filename,
      JSON.stringify({
        revision: current.revision,
        configuration: { ...current.configuration, schemaVersion: 2 },
      }),
    );
    expect(
      (await localWrite("/reload", { revision: current.revision }, "POST"))
        .status,
    ).toBe(400);
    expect((await localRead()).revision).toBe(current.revision);
  });

  it("validates prompts and settings, audits prompt hashes, and makes clearing credentials explicit", async () => {
    provider = await startStubLlmProvider();
    await start({
      BADGER_LLM_KEY: "ab".repeat(32),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    });
    let current = await configure(provider.url);
    for (const mutate of [
      (c: typeof current.configuration) => {
        c.prompts["script-side-effects"].text = "Wrong {{secret}}";
      },
      (c: typeof current.configuration) => {
        c.models[0].settings.effort = "ultra";
        c.models[0].descriptors[1].options.push({
          value: "ultra",
          label: "Ultra",
        });
      },
      (c: typeof current.configuration) => {
        c.models[0].settings.output = 500000;
      },
      (c: typeof current.configuration) => {
        c.models[0].settings.unknown = true;
      },
    ]) {
      const invalid = structuredClone(current.configuration);
      mutate(invalid);
      expect(
        (
          await write(
            "/api/v1/admin/llm",
            { revision: current.revision, configuration: invalid },
            administrator,
            "PUT",
          )
        ).status,
      ).toBe(400);
    }
    current.configuration.prompts["script-side-effects"].text +=
      "\nBe concise.";
    const change = await write(
      "/api/v1/admin/llm",
      { revision: current.revision, configuration: current.configuration },
      administrator,
      "PUT",
    );
    expect(change.status).toBe(200);
    current = await change.json();
    const audit = await (
      await service.request("/api/v1/audit-events?action=llm_prompts.updated", {
        as: administrator,
      })
    ).json();
    expect(audit.events[0].before.hash).not.toBe(audit.events[0].after.hash);
    const clear = await write(
      "/api/v1/admin/llm",
      {
        revision: current.revision,
        configuration: current.configuration,
        secrets: { flash: { action: "clear" } },
      },
      administrator,
      "PUT",
    );
    expect(clear.status).toBe(200);
    const cleared = await clear.json();
    expect(cleared.credentials.flash.configured).toBe(false);
    expect(
      (
        await write("/api/v1/admin/llm/test", {
          revision: cleared.revision,
          modelId: "flash",
        })
      ).status,
    ).toBe(400);
    expect(provider.requests).toHaveLength(0);
    const entry = await skill();
    const base = `/api/v1/skills/${entry.id}`;
    const { preview } = await (
      await write(`${base}/upload-preview`, uploadedSource)
    ).json();
    const missingKey = await write(`${base}/side-effect-suggestions`, {
      previewId: preview.suggestion.id,
      expectedHash: preview.hash,
    });
    expect((await missingKey.json()).suggestion).toMatchObject({
      status: "failed",
      scripts: [],
    });
    expect(provider.requests).toHaveLength(0);
  });
});

describe("Protected LLM credentials", () => {
  it("supports external references without encryption and refuses prompts containing configured keys", async () => {
    provider = await startStubLlmProvider();
    provider.requireKey("synthetic-external-key-95");
    await start({
      BADGER_LLM_SECRET_FLASH: "synthetic-external-key-95",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    });
    const current = await configuration();
    current.configuration.models = [
      { ...model(provider.url), secretRef: "env:BADGER_LLM_SECRET_FLASH" },
    ];
    current.configuration.bindings["script-side-effects"] = "flash";
    const saved = await write(
      "/api/v1/admin/llm",
      { revision: current.revision, configuration: current.configuration },
      administrator,
      "PUT",
    );
    expect(saved.status).toBe(200);
    const accepted = await saved.json();
    expect(accepted.secretStorageConfigured).toBe(false);
    expect(accepted.credentials.flash.configured).toBe(true);
    expect(
      (
        await write("/api/v1/admin/llm/test", {
          revision: accepted.revision,
          modelId: "flash",
        })
      ).status,
    ).toBe(200);
    accepted.configuration.prompts["script-side-effects"].text +=
      "\nsynthetic-external-key-95";
    const refused = await write(
      "/api/v1/admin/llm",
      { revision: accepted.revision, configuration: accepted.configuration },
      administrator,
      "PUT",
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain("synthetic-external-key-95");
    expect((await configuration()).revision).toBe(accepted.revision);
  });
});

const file = (path: string, text: string) => ({
  path,
  content: Buffer.from(text).toString("base64"),
});
const uploadedSource = {
  files: [
    file(
      "SKILL.md",
      "---\nname: example\ndescription: Synthetic upload\n---\n# Example\nRead bundled wrappers.\n",
    ),
    file("scripts/run.sh", "#!/bin/sh\n. ../references/wrapper.sh\n"),
    file(
      "references/wrapper.sh",
      "curl https://synthetic.example/data > result.txt\n",
    ),
  ],
};
async function skill() {
  const { group } = await (
    await write("/api/v1/groups", { name: "Research" })
  ).json();
  const { skill } = await (
    await write("/api/v1/skills", { name: "example", groupId: group.id })
  ).json();
  return skill;
}

describe("Script side-effect suggestions", () => {
  it("binds suggestions to validated preview evidence and preserves explicit immutable confirmation", async () => {
    provider = await startStubLlmProvider();
    await start({
      BADGER_LLM_KEY: "ab".repeat(32),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    });
    await configure(provider.url);
    const entry = await skill();
    const base = `/api/v1/skills/${entry.id}`;
    const response = await write(`${base}/upload-preview`, uploadedSource);
    expect(response.status).toBe(200);
    const { preview } = await response.json();
    expect(preview.suggestion.state).toBe("ready");
    expect(provider.requests).toHaveLength(0);
    const scriptHash = preview.inventory.find(
      (f: { path: string }) => f.path === "scripts/run.sh",
    ).hash;
    const wrapperHash = preview.inventory.find(
      (f: { path: string }) => f.path === "references/wrapper.sh",
    ).hash;
    provider.respond({
      scripts: [
        {
          path: "scripts/run.sh",
          effects: ["local-writes", "network"],
          rationale: "The bundled wrapper calls curl and writes result.txt.",
          complete: true,
          uncertainty: "",
          citations: [
            {
              path: "scripts/run.sh",
              hash: scriptHash,
              startLine: 2,
              endLine: 2,
            },
            {
              path: "references/wrapper.sh",
              hash: wrapperHash,
              startLine: 1,
              endLine: 1,
            },
          ],
        },
      ],
    });
    const suggested = await write(`${base}/side-effect-suggestions`, {
      previewId: preview.suggestion.id,
      expectedHash: preview.hash,
    });
    expect(suggested.status, await suggested.clone().text()).toBe(200);
    const { suggestion } = await suggested.json();
    expect(suggestion.status).toBe("complete");
    expect(suggestion.binding.sourceHash).toBe(preview.hash);
    expect(suggestion.binding.scripts).toEqual([
      { path: "scripts/run.sh", hash: scriptHash },
    ]);
    expect(suggestion.binding.promptRevision).toBe(
      preview.suggestion.prompt.revision,
    );
    expect(suggestion.scripts[0].effects).toEqual(["local-writes", "network"]);
    expect(provider.requests[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("references/wrapper.sh"),
        }),
      ]),
    );
    expect(
      (
        await (
          await service.request(`${base}/versions`, { as: administrator })
        ).json()
      ).versions,
    ).toEqual([]);
    expect(
      (
        await write(`${base}/versions`, {
          ...uploadedSource,
          expectedHash: preview.hash,
          scripts: { "scripts/run.sh": ["network", "local-writes"] },
        })
      ).status,
    ).toBe(400);
    const confirmed = await write(`${base}/versions`, {
      ...uploadedSource,
      confirmed: true,
      expectedHash: preview.hash,
      scripts: { "scripts/run.sh": ["network", "local-writes"] },
    });
    expect(confirmed.status).toBe(201);
    expect((await confirmed.json()).version.hash).toBe(preview.hash);
    expect(
      (
        await write(`${base}/side-effect-suggestions`, {
          previewId: preview.suggestion.id,
          expectedHash: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
    const current = await configuration();
    current.configuration.models.push({
      ...current.configuration.models[0],
      id: "second",
      model: "second-model-alias",
      name: "Second model",
      secretRef: "env:BADGER_LLM_SECRET_SECOND",
      settings: { effort: "high" },
    });
    current.configuration.bindings["script-side-effects"] = "second";
    const saved = await write(
      "/api/v1/admin/llm",
      {
        revision: current.revision,
        configuration: current.configuration,
        secrets: {
          second: { action: "replace", value: "synthetic-second-key" },
        },
      },
      administrator,
      "PUT",
    );
    expect(saved.status).toBe(200);
    const next = await (
      await write(`${base}/upload-preview`, uploadedSource)
    ).json();
    const changedBinding = await write(`${base}/side-effect-suggestions`, {
      previewId: next.preview.suggestion.id,
      expectedHash: next.preview.hash,
    });
    expect(changedBinding.status).toBe(200);
    expect((await changedBinding.json()).suggestion.binding.modelId).toBe(
      "second",
    );
    expect(provider.requests[1]).toMatchObject({
      model: "second-model-alias",
      reasoning_effort: "high",
    });
    expect(JSON.stringify(provider.requests)).not.toContain(
      service.config.storage.root,
    );
    expect(provider.requests[1]).not.toHaveProperty("tools");
  });

  it("refuses malformed effects, unknown scripts and unsupported evidence, and leaves uncertain scripts undeclared", async () => {
    provider = await startStubLlmProvider();
    await start({
      BADGER_LLM_KEY: "ab".repeat(32),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    });
    await configure(provider.url);
    const entry = await skill();
    const base = `/api/v1/skills/${entry.id}`;
    async function attempt(change: Record<string, unknown>) {
      const { preview } = await (
        await write(`${base}/upload-preview`, uploadedSource)
      ).json();
      const hash = preview.inventory.find(
        (f: { path: string }) => f.path === "scripts/run.sh",
      ).hash;
      provider.respond({
        scripts: [
          {
            path: "scripts/run.sh",
            effects: ["network", "local-writes"],
            rationale: "Calls a bundled wrapper.",
            complete: true,
            uncertainty: "",
            citations: [
              { path: "scripts/run.sh", hash, startLine: 1, endLine: 2 },
            ],
            ...change,
          },
        ],
      });
      const response = await write(`${base}/side-effect-suggestions`, {
        previewId: preview.suggestion.id,
        expectedHash: preview.hash,
      });
      expect(response.status).toBe(200);
      return (await response.json()).suggestion;
    }
    for (const invalid of [
      { effects: ["harmless"] },
      { effects: ["none", "network"] },
      { path: "scripts/unknown.sh" },
      {
        citations: [
          {
            path: "scripts/run.sh",
            hash: "0".repeat(64),
            startLine: 1,
            endLine: 1,
          },
        ],
      },
      {
        citations: [
          {
            path: "/etc/passwd",
            hash: "0".repeat(64),
            startLine: 1,
            endLine: 1,
          },
        ],
      },
      {
        citations: [
          {
            path: "scripts/run.sh",
            hash: "0".repeat(64),
            startLine: 0,
            endLine: 10000,
          },
        ],
      },
    ]) {
      const result = await attempt(invalid);
      expect(result.status).toBe("failed");
      expect(result.scripts).toEqual([]);
    }
    const uncertain = await attempt({
      complete: false,
      effects: [],
      uncertainty:
        "The wrapper invokes a tool whose implementation is missing.",
    });
    expect(uncertain.status).toBe("incomplete");
    expect(uncertain.scripts[0].complete).toBe(false);
    provider.respond({ scripts: [] });
    const { preview } = await (
      await write(`${base}/upload-preview`, uploadedSource)
    ).json();
    const missing = await write(`${base}/side-effect-suggestions`, {
      previewId: preview.suggestion.id,
      expectedHash: preview.hash,
    });
    expect((await missing.json()).suggestion.status).toBe("incomplete");
    expect(
      (
        await (
          await service.request(`${base}/versions`, { as: administrator })
        ).json()
      ).versions,
    ).toEqual([]);
  });

  it("does not call a model for script-free, disabled or oversized evidence and reports input context failures", async () => {
    provider = await startStubLlmProvider();
    await start({
      BADGER_LLM_KEY: "ab".repeat(32),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    });
    let current = await configure(provider.url);
    const entry = await skill();
    const base = `/api/v1/skills/${entry.id}`;
    const empty = await (
      await write(`${base}/upload-preview`, {
        files: [uploadedSource.files[0]],
      })
    ).json();
    expect(empty.preview.suggestion.state).toBe("no-scripts");
    current.configuration.limits.maxSourceBytes = 1024;
    current = await (
      await write(
        "/api/v1/admin/llm",
        { revision: current.revision, configuration: current.configuration },
        administrator,
        "PUT",
      )
    ).json();
    const tooLarge = await (
      await write(`${base}/upload-preview`, {
        files: [
          ...uploadedSource.files,
          file("references/large.txt", "x".repeat(2000)),
        ],
      })
    ).json();
    expect(tooLarge.preview.suggestion.state).toBe("incomplete");
    current.configuration.models[0].settings = { context: 5000, output: 4096 };
    current = await (
      await write(
        "/api/v1/admin/llm",
        { revision: current.revision, configuration: current.configuration },
        administrator,
        "PUT",
      )
    ).json();
    const { preview } = await (
      await write(`${base}/upload-preview`, uploadedSource)
    ).json();
    const tooSmall = await write(`${base}/side-effect-suggestions`, {
      previewId: preview.suggestion.id,
      expectedHash: preview.hash,
    });
    expect((await tooSmall.json()).suggestion.message).toContain(
      "context budget",
    );
    current.configuration.models[0].enabled = false;
    await write(
      "/api/v1/admin/llm",
      { revision: current.revision, configuration: current.configuration },
      administrator,
      "PUT",
    );
    const disabled = await (
      await write(`${base}/upload-preview`, uploadedSource)
    ).json();
    expect(disabled.preview.suggestion.state).toBe("unconfigured");
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects stale upload/configuration results and cross-Group or preview-owner access", async () => {
    provider = await startStubLlmProvider();
    await start({
      BADGER_LLM_KEY: "ab".repeat(32),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    });
    let current = await configure(provider.url);
    const entry = await skill();
    const base = `/api/v1/skills/${entry.id}`;
    const { preview } = await (
      await write(`${base}/upload-preview`, uploadedSource)
    ).json();
    const input = {
      previewId: preview.suggestion.id,
      expectedHash: preview.hash,
    };
    expect(
      (
        await write(`${base}/side-effect-suggestions`, input, {
          subject: "other-group",
        })
      ).status,
    ).toBe(404);
    const secondAdmin = {
      subject: "second-admin",
      email: "second@example.com",
    };
    await write("/api/v1/bindings", {
      scopeType: "organization",
      scopeId: null,
      role: "Administrator",
      email: secondAdmin.email,
    });
    expect(
      (await write(`${base}/side-effect-suggestions`, input, secondAdmin))
        .status,
    ).toBe(404);
    provider.respond({ scripts: [] });
    provider.holdResponses();
    const pending = write(`${base}/side-effect-suggestions`, input);
    await expect.poll(() => provider.requests.length).toBe(1);
    current.configuration.prompts["script-side-effects"].text +=
      "\nChanged prompt.";
    current = await (
      await write(
        "/api/v1/admin/llm",
        { revision: current.revision, configuration: current.configuration },
        administrator,
        "PUT",
      )
    ).json();
    provider.releaseResponses();
    expect((await pending).status).toBe(409);
    const newer = await (
      await write(`${base}/upload-preview`, uploadedSource)
    ).json();
    provider.holdResponses();
    const another = write(`${base}/side-effect-suggestions`, {
      previewId: newer.preview.suggestion.id,
      expectedHash: newer.preview.hash,
    });
    await expect.poll(() => provider.requests.length).toBe(2);
    await write(`${base}/upload-preview`, {
      files: [
        ...uploadedSource.files,
        file("references/new.txt", "New source"),
      ],
    });
    provider.releaseResponses();
    expect((await another).status).toBe(409);
  });

  it("lets Field experts suggest within their Group and refuses disclosure after upload permission is revoked", async () => {
    provider = await startStubLlmProvider();
    await start({
      BADGER_LLM_KEY: "ab".repeat(32),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    });
    await configure(provider.url);
    const entry = await skill();
    const base = `/api/v1/skills/${entry.id}`;
    const expert = {
      subject: "expert-uploader",
      email: "expert-uploader@example.com",
    };
    const lead = { subject: "library-lead", email: "library-lead@example.com" };
    const { workflow } = await (
      await write("/api/v1/workflows", {
        groupId: entry.groupId,
        name: "expert-workflow",
        goal: "Review source",
        intent: "new-skill",
        locale: "en",
      })
    ).json();
    const { binding } = await (
      await write("/api/v1/bindings", {
        scopeType: "workflow",
        scopeId: workflow.id,
        role: "Field expert",
        email: expert.email,
      })
    ).json();
    await write("/api/v1/bindings", {
      scopeType: "group",
      scopeId: entry.groupId,
      role: "Group lead",
      email: lead.email,
    });
    const { preview } = await (
      await write(`${base}/upload-preview`, uploadedSource, expert)
    ).json();
    const input = {
      previewId: preview.suggestion.id,
      expectedHash: preview.hash,
    };
    expect(
      (await write(`${base}/side-effect-suggestions`, input, lead)).status,
    ).toBe(403);
    provider.respond({ scripts: [] });
    provider.holdResponses();
    const pending = write(`${base}/side-effect-suggestions`, input, expert);
    await expect.poll(() => provider.requests.length, { interval: 10 }).toBe(1);
    const bindings = await (
      await service.request(`/api/v1/workflows/${workflow.id}`, {
        as: administrator,
      })
    ).json();
    const active = bindings.bindings.find(
      (item: { id: string }) => item.id === binding.id,
    );
    const removed = await write(
      `/api/v1/bindings/${binding.id}`,
      { revision: active.revision },
      administrator,
      "DELETE",
    );
    expect(removed.status).toBe(200);
    provider.releaseResponses();
    expect((await pending).status).toBe(403);
  });

  it("reports provider failures, timeouts, oversized responses and busy requests without retries or harmless defaults", async () => {
    provider = await startStubLlmProvider();
    await start({
      BADGER_LLM_KEY: "ab".repeat(32),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    });
    let current = await configure(provider.url);
    current.configuration.limits = {
      ...current.configuration.limits,
      timeoutMs: 100,
      maxResponseBytes: 1024,
      maxConcurrent: 1,
    };
    current = await (
      await write(
        "/api/v1/admin/llm",
        { revision: current.revision, configuration: current.configuration },
        administrator,
        "PUT",
      )
    ).json();
    const entry = await skill();
    const base = `/api/v1/skills/${entry.id}`;
    async function attempt() {
      const { preview } = await (
        await write(`${base}/upload-preview`, uploadedSource)
      ).json();
      return write(`${base}/side-effect-suggestions`, {
        previewId: preview.suggestion.id,
        expectedHash: preview.hash,
      });
    }
    for (const failure of [
      { status: 401, raw: "synthetic-provider-secret-95" },
      { raw: "not-json" },
      { raw: "x".repeat(2048) },
      { delayMs: 250 },
    ]) {
      provider.respond({ scripts: [] }, failure);
      const result = await attempt();
      expect(result.status).toBe(200);
      const text = await result.text();
      expect(text).not.toContain("synthetic-provider-secret-95");
      expect(JSON.parse(text).suggestion).toMatchObject({
        status: failure.raw?.length === 2048 ? "incomplete" : "failed",
        scripts: [],
      });
    }
    expect(provider.requests).toHaveLength(4);
    current.configuration.limits.timeoutMs = 5000;
    current = await (
      await write(
        "/api/v1/admin/llm",
        { revision: current.revision, configuration: current.configuration },
        administrator,
        "PUT",
      )
    ).json();
    provider.respond({ scripts: [] });
    provider.holdResponses();
    const pending = attempt();
    await expect.poll(() => provider.requests.length, { interval: 5 }).toBe(5);
    const busy = await attempt();
    expect(busy.status).toBe(503);
    expect((await busy.json()).error.message).toContain("busy");
    provider.releaseResponses();
    await pending;
    expect(provider.requests).toHaveLength(5);
  });

  it("uses the same bound suggestion path for a validated Git import", async () => {
    provider = await startStubLlmProvider();
    remote = await startStubGitRepository(
      Object.fromEntries(
        uploadedSource.files.map((f) => [
          f.path,
          Buffer.from(f.content, "base64").toString("utf8"),
        ]),
      ),
    );
    await start({
      BADGER_LLM_KEY: "ab".repeat(32),
      BADGER_GIT_ALLOWED_ORIGINS: remote.origin,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "*",
    });
    await configure(provider.url);
    const entry = await skill();
    const base = `/api/v1/skills/${entry.id}`;
    const { repository } = await (
      await write(`${base}/repositories`, { url: remote.url })
    ).json();
    const response = await write(`${base}/git-preview`, {
      repositoryId: repository.id,
      commit: remote.commit,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { preview } = await response.json();
    expect(preview.suggestion.state).toBe("ready");
    provider.respond({ scripts: [] });
    const suggested = await write(`${base}/side-effect-suggestions`, {
      previewId: preview.suggestion.id,
      expectedHash: preview.hash,
    });
    expect(suggested.status).toBe(200);
    expect((await suggested.json()).suggestion.status).toBe("incomplete");
    expect(provider.requests).toHaveLength(1);
  });
});
