import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  startTestService,
  type TestService,
} from "@realityjunky/badger-server/testing";
import { createEngineerMcp } from "../src/index.js";
import { canonicalHash, type FactoryPlan } from "@realityjunky/badger";

let service: TestService;
const clients: Client[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const folder of folders.splice(0))
    await fs.rm(folder, { recursive: true, force: true });
  await service?.close();
});
async function request(route: string, method = "GET", body?: unknown) {
  const response = await service.request(`/api/v1${route}`, {
    method,
    headers: { origin: service.baseUrl, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value;
}
async function connect(scopes = ["engineer"]) {
  const { secret } = await request("/me/tokens", "POST", {
    name: "Engineer Agent",
    scopes,
  });
  const server = createEngineerMcp({
    url: service.baseUrl,
    token: secret,
    agentHost: "Engineer Agent",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "Engineer Agent", version: "1" });
  clients.push(client);
  await client.connect(a);
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  return JSON.parse((response.content as { text: string }[])[0].text);
}

it("offers the engineer profile and hands a claimed job's context and exact pinned files to a private local folder", async () => {
  service = await startTestService({ mode: "local" });
  const { group } = await request("/groups", "POST", { name: "Research" });
  const { workflow, version } = await request("/workflows", "POST", {
    groupId: group.id,
    name: "engineer-work",
    goal: "Draft questions",
    intent: "new-skill",
    locale: "en",
  });
  const context = { workflowId: workflow.id, versionId: version.id };
  const base = `/workflows/${workflow.id}/versions/${version.id}`;
  const { skill } = await request("/skills", "POST", {
    groupId: group.id,
    name: "storage",
  });
  const skillText =
    "---\nname: storage\ndescription: Storage guidance.\n---\n\n# Storage\nKeep samples cold.\n";
  const upload = {
    files: [
      { path: "SKILL.md", content: Buffer.from(skillText).toString("base64") },
    ],
    scripts: {},
  };
  const { preview } = await request(
    `/skills/${skill.id}/upload-preview`,
    "POST",
    upload,
  );
  await request(`/skills/${skill.id}/versions`, "POST", {
    ...upload,
    confirmed: true,
    expectedHash: preview.hash,
  });
  await request(`${base}/pins`, "POST", {
    skillId: skill.id,
    hash: preview.hash,
    purpose: "source",
  });
  const { round } = await request(`${base}/questionnaire/rounds`, "POST", {
    title: "Storage",
  });
  const { job } = await request(`${base}/drafting-jobs`, "POST", {
    kind: "draft-questions",
    roundId: round.id,
    confirmed: true,
  });
  const client = await connect();
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
    expect.arrayContaining([
      "whoami",
      "inbox",
      "list_jobs",
      "claim_job",
      "submit_job",
      "release_job",
      "questionnaire",
      "ledger",
      "readiness",
    ]),
  );
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
    "accept_job",
  );
  expect((await call(client, "list_jobs", context)).jobs).toEqual([
    expect.objectContaining({ id: job.id }),
  ]);
  const claimed = await call(client, "claim_job", {
    ...context,
    jobId: job.id,
    revision: job.revision,
  });
  folders.push(claimed.folder);
  expect(claimed).toMatchObject({
    kind: "draft-questions",
    roundId: round.id,
    parentQuestionId: null,
  });
  expect(
    JSON.parse(
      await fs.readFile(path.join(claimed.folder, "job.json"), "utf8"),
    ),
  ).toMatchObject({ id: job.id, kind: "draft-questions", roundId: round.id });
  if (process.platform !== "win32")
    expect((await fs.stat(claimed.folder)).mode & 0o777).toBe(0o700);
  const bundle = JSON.parse(
    await fs.readFile(path.join(claimed.folder, "context.json"), "utf8"),
  );
  expect(bundle.pins).toEqual([
    expect.objectContaining({ hash: preview.hash }),
  ]);
  expect(
    await fs.readFile(
      path.join(claimed.folder, "skills", skill.id, preview.hash, "SKILL.md"),
      "utf8",
    ),
  ).toBe(skillText);
  await fs.writeFile(
    path.join(claimed.folder, "result.json"),
    JSON.stringify({ questions: [] }),
  );
  expect(
    (
      await client.callTool({
        name: "submit_job",
        arguments: { ...context, jobId: job.id, folder: claimed.folder },
      })
    ).isError,
  ).toBe(true);
  const released = await call(client, "release_job", {
    ...context,
    jobId: job.id,
    folder: claimed.folder,
  });
  expect(released.job.status).toBe("queued");
  const next = await call(client, "claim_job", {
    ...context,
    jobId: job.id,
    revision: released.job.revision,
  });
  folders.push(next.folder);
  const result = {
    questions: [
      {
        text: "Which sample is used?",
        topic: "scope",
        targets: [{ kind: "workflow", id: workflow.id }],
        rationale: "Define the inputs.",
        evidence: [],
        assignees: [{ kind: "role", role: "Field expert" }],
        priority: 90,
      },
    ],
  };
  const resultFile = path.join(next.folder, "result.json");
  const sourceFile = path.join(next.folder, "suggestion.json");
  await fs.writeFile(sourceFile, JSON.stringify(result));
  await fs.symlink(sourceFile, resultFile);
  expect(
    (
      await client.callTool({
        name: "submit_job",
        arguments: { ...context, jobId: job.id, folder: next.folder },
      })
    ).isError,
  ).toBe(true);
  await fs.unlink(resultFile);
  await fs.writeFile(resultFile, JSON.stringify(result));
  const submitted = await call(client, "submit_job", {
    ...context,
    jobId: job.id,
    folder: next.folder,
  });
  expect(submitted.job.status).toBe("submitted");
  expect(submitted).toMatchObject({
    requiresPerson: true,
    dashboardUrl: `${service.baseUrl}/questionnaire?workflow=${workflow.id}&version=${version.id}&panel=suggestions`,
  });
  const dashboard = await call(client, "open_dashboard", {
    ...context,
    action: "review_suggestions",
  });
  expect(dashboard).toMatchObject({
    requiresPerson: true,
    url: submitted.dashboardUrl,
  });
  const suggestions = await request(`${base}/questionnaire`);
  expect(suggestions.suggestions).toEqual([
    expect.objectContaining({ id: job.id, result }),
  ]);
  expect(suggestions.questions).toEqual([]);
  expect((await call(client, "questionnaire", context)).questions).toEqual([]);
  expect(await call(client, "ledger", context)).toHaveProperty("handoff");
  expect(await call(client, "readiness", context)).toHaveProperty("readiness");
  const { job: studyJob } = await request(`${base}/drafting-jobs`, "POST", {
    kind: "source-study",
    skillId: skill.id,
    confirmed: true,
  });
  const studyClaim = await call(client, "claim_job", {
    ...context,
    jobId: studyJob.id,
    revision: studyJob.revision,
  });
  folders.push(studyClaim.folder);
  expect(studyClaim).toMatchObject({
    kind: "source-study",
    skillId: skill.id,
    roundId: null,
  });
  const studyResult = {
    facts: [
      {
        statement: "Samples must be kept cold.",
        evidence: [
          {
            skillId: skill.id,
            hash: preview.hash,
            path: "SKILL.md",
            fileHash: createHash("sha256").update(skillText).digest("hex"),
            startLine: 7,
            endLine: 7,
          },
        ],
      },
    ],
    interfaces: [],
  };
  await fs.writeFile(
    path.join(studyClaim.folder, "result.json"),
    JSON.stringify(studyResult),
  );
  const studySubmission = await call(client, "submit_job", {
    ...context,
    jobId: studyJob.id,
    folder: studyClaim.folder,
  });
  expect(studySubmission).toMatchObject({
    requiresPerson: true,
    job: { status: "submitted", result: studyResult },
  });
  expect((await request(`${base}/source-study`)).facts).toEqual([]);
  await service.runSourceCheckJobs();
  async function confirm(gate: string) {
    const { preview } = await request(
      `${base}/gates/${gate}/preview`,
      "POST",
      {},
    );
    await request(`${base}/gates/${gate}/commit`, "POST", {
      confirmationHash: preview.confirmationHash,
      requestId: crypto.randomUUID(),
    });
  }
  await confirm("sources");
  const { record } = await request(`${base}/source-study/facts`, "POST", {
    statement: "Keep samples cold.",
    evidence: [
      {
        skillId: skill.id,
        hash: preview.hash,
        path: "SKILL.md",
        startLine: 7,
        endLine: 7,
        fileHash: createHash("sha256").update(skillText).digest("hex"),
      },
    ],
  });
  await confirm(`source-study/${skill.id}`);
  const { handoff } = await request(`${base}/questionnaire/ledger`);
  const topic = {
    summary: "Keep samples cold; no other behavior is needed.",
    factIds: [record.id],
  };
  const semantics = {
    nodes: [{ id: "store", order: 0, responsibility: topic }],
    topics: Object.fromEntries(
      handoff.readiness
        .filter((r: { topic: string }) => r.topic !== "scope")
        .map((r: { topic: string }) => [r.topic, topic]),
    ),
  };
  const { composition } = await request(
    `${base}/dossier/preview`,
    "POST",
    semantics,
  );
  await request(`${base}/dossier/compose`, "POST", {
    ...semantics,
    confirmationHash: composition.hash,
  });
  await confirm("dossier");
  const { job: planJob } = await request(`${base}/drafting-jobs`, "POST", {
    kind: "draft-plan",
    confirmed: true,
  });
  const planClaim = await call(client, "claim_job", {
    ...context,
    jobId: planJob.id,
    revision: planJob.revision,
  });
  folders.push(planClaim.folder);
  const planContext = JSON.parse(
    await fs.readFile(path.join(planClaim.folder, "context.json"), "utf8"),
  ) as { planning: { skeleton: FactoryPlan; input: { dossierHash: string } } };
  expect(planContext.planning.input.dossierHash).toBe(composition.hash);
  const plan = planContext.planning.skeleton;
  plan.workflow.customNodes[0]!.implementation.skill = "storage";
  await fs.writeFile(
    path.join(planClaim.folder, "result.json"),
    JSON.stringify({ plan }),
  );
  const submittedPlan = await call(client, "submit_job", {
    ...context,
    jobId: planJob.id,
    folder: planClaim.folder,
  });
  expect(submittedPlan.job.status).toBe("submitted");
  expect(submittedPlan).toMatchObject({
    requiresPerson: true,
    dashboardUrl: `${service.baseUrl}/workflows/${workflow.id}/versions/${version.id}#plan`,
  });
  expect((await request(`${base}/plan`)).versions).toEqual([]);
  const planDecision = { revision: submittedPlan.job.revision, plan };
  const acceptedPlan = await request(
    `${base}/drafting-jobs/${planJob.id}/accept-preview`,
    "POST",
    planDecision,
  );
  await request(`${base}/drafting-jobs/${planJob.id}/accept`, "POST", {
    ...planDecision,
    confirmed: true,
    confirmationHash: acceptedPlan.preview.confirmationHash,
    requestId: "accept-mcp-plan",
  });
  async function approve(gate: string) {
    const { preview } = await request(
      `${base}/gates/${gate}/preview`,
      "POST",
      {},
    );
    return request(`${base}/gates/${gate}/commit`, "POST", {
      confirmationHash: preview.confirmationHash,
      requestId: crypto.randomUUID(),
    });
  }
  await approve("plan");
  const proposal = await approve("proposal");
  await request(`${base}/proposal/initialize`, "POST", {
    proposalHash: proposal.confirmation.boundHashes.proposal,
    confirmed: true,
    requestId: "mcp-init",
  });
  await service.worker().runOnce();
  const before = await request(`${base}/package`);
  const generation = await approve("generation");
  await request(`${base}/package/generate`, "POST", {
    confirmed: true,
    confirmationHash: generation.confirmation.confirmationHash,
    stateHash: before.currentStateHash,
    requestId: "mcp-generate",
  });
  await service.worker().runOnce();
  const laneJobs = await request(`${base}/package/authoring-jobs`, "POST", {
    confirmed: true,
  });
  const lane = laneJobs.jobs[0];
  const laneClaim = await call(client, "claim_job", {
    ...context,
    jobId: lane.id,
    revision: lane.revision,
  });
  folders.push(laneClaim.folder);
  const laneContext = JSON.parse(
    await fs.readFile(path.join(laneClaim.folder, "context.json"), "utf8"),
  );
  expect(laneContext.authoring.handoff.lane).toBe("script");
  for (const file of laneContext.authoring.files)
    expect(
      await fs.readFile(path.join(laneClaim.folder, file.path), "utf8"),
    ).toBe(file.text);
  await fs.writeFile(
    path.join(laneClaim.folder, "result.json"),
    JSON.stringify({
      laneOutput: {
        lane: "script",
        status: "NEEDS_CONTEXT",
        semanticDossierHash: laneContext.authoring.plan.semanticDossierHash,
        summary: "Confirm the sample source.",
        claims: [],
        artifacts: [],
        action: {
          kind: "question",
          prompt: "What sample is used?",
          requirement: "/nodes/0/responsibility",
        },
      },
    }),
  );
  const submittedLane = await call(client, "submit_job", {
    ...context,
    jobId: lane.id,
    folder: laneClaim.folder,
  });
  expect(submittedLane).toMatchObject({
    requiresPerson: true,
    dashboardUrl: `${service.baseUrl}/workflows/${workflow.id}/versions/${version.id}#package`,
    job: { status: "submitted" },
  });
  expect(
    (await request(`${base}/package/authoring`)).readiness.records.script,
  ).toBeUndefined();

  await request(`${base}/pins/${skill.id}`, "DELETE", { revision: 1 });
  const cancelled = await request(`${base}/drafting-jobs/${job.id}`);
  expect(cancelled.job.status).toBe("cancelled");
  const expertScoped = await connect(["expert"]);
  expect(
    (await expertScoped.listTools()).tools.map((t) => t.name),
  ).not.toContain("claim_job");
});

it("writes only the pinned Skills a claimed job's kind reads into its folder", async () => {
  service = await startTestService({ mode: "local" });
  const { group } = await request("/groups", "POST", { name: "Research" });
  const { workflow, version } = await request("/workflows", "POST", {
    groupId: group.id,
    name: "claim-folders",
    goal: "Study sources",
    intent: "new-skill",
    locale: "en",
  });
  const context = { workflowId: workflow.id, versionId: version.id };
  const base = `/workflows/${workflow.id}/versions/${version.id}`;
  const pins: { skillId: string; versionHash: string }[] = [];
  for (const name of ["storage", "transport"]) {
    const { skill } = await request("/skills", "POST", {
      groupId: group.id,
      name,
    });
    const text = `---\nname: ${name}\ndescription: ${name} guidance.\n---\n\n# ${name}\n`;
    const upload = {
      files: [
        { path: "SKILL.md", content: Buffer.from(text).toString("base64") },
      ],
      scripts: {},
    };
    const { preview } = await request(
      `/skills/${skill.id}/upload-preview`,
      "POST",
      upload,
    );
    await request(`/skills/${skill.id}/versions`, "POST", {
      ...upload,
      confirmed: true,
      expectedHash: preview.hash,
    });
    await request(`${base}/pins`, "POST", {
      skillId: skill.id,
      hash: preview.hash,
    });
    pins.push({ skillId: skill.id, versionHash: preview.hash });
  }
  await request("/bindings", "POST", {
    scopeType: "workflow",
    scopeId: workflow.id,
    email: "expert@example.com",
    role: "Field expert",
  });
  const { round } = await request(`${base}/questionnaire/rounds`, "POST", {
    title: "Storage",
  });
  const { question } = await request(
    `${base}/questionnaire/rounds/${round.id}/questions`,
    "POST",
    {
      text: "Which sample is used?",
      topic: "scope",
      targets: [{ kind: "workflow", id: workflow.id }],
      rationale: "Define the inputs.",
      evidence: [],
      assignees: [{ kind: "role", role: "Field expert" }],
      priority: 90,
    },
  );
  const client = await connect();
  const bySkill = (a: { skillId: string }, b: { skillId: string }) =>
    a.skillId.localeCompare(b.skillId);
  for (const [target, expected] of [
    [{ kind: "source-study", skillId: pins[1]!.skillId }, [pins[1]!]],
    [{ kind: "draft-questions", roundId: round.id }, pins],
    [{ kind: "translate-question", questionId: question.id, locale: "fr" }, []],
  ] as const) {
    const { job } = await request(`${base}/drafting-jobs`, "POST", {
      ...target,
      confirmed: true,
    });
    const claimed = await call(client, "claim_job", {
      ...context,
      jobId: job.id,
      revision: job.revision,
    });
    folders.push(claimed.folder);
    expect([...claimed.skills].sort(bySkill)).toEqual(
      [...expected].sort(bySkill),
    );
    const entries = await fs.readdir(claimed.folder);
    expect(entries.sort()).toEqual(
      [
        "claim.json",
        "context.json",
        "job.json",
        "output-schema.json",
        ...(expected.length ? ["skills"] : []),
      ].sort(),
    );
    if (expected.length)
      expect(
        (await fs.readdir(path.join(claimed.folder, "skills"))).sort(),
      ).toEqual(expected.map((pin) => pin.skillId).sort());
    expect(
      JSON.parse(
        await fs.readFile(path.join(claimed.folder, "context.json"), "utf8"),
      ).pins,
    ).toHaveLength(2);
  }
});

it("refuses a claimed Skill path with a .git component in any letter case before writing anything, and releases the job", async () => {
  // Uploads refuse these paths now; a version stored earlier may hold them.
  const versionHash = "a".repeat(64);
  const sha256 = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  let served: string[] = [];
  const releases: unknown[] = [];
  const stub = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const send = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/api/v1/me/mcp")
      return send({ capabilities: { compose: true } });
    if (request.url?.endsWith("/release")) {
      releases.push(JSON.parse(body));
      return send({ job: { status: "queued" } });
    }
    const files = served.map((file) => ({
      path: file,
      text: file === "SKILL.md" ? "# Unsafe\n" : "[core]\n\tfsmonitor = x\n",
    }));
    const contextBundle = {
      pins: [
        {
          skillId: "skill",
          hash: versionHash,
          inventory: files.map((f) => ({ path: f.path, hash: sha256(f.text) })),
        },
      ],
    };
    send({
      job: {
        id: "job",
        kind: "source-study",
        roundId: null,
        skillId: "skill",
        questionId: null,
        locale: null,
        parentQuestionId: null,
        revision: 2,
        status: "claimed",
        contextHash: canonicalHash(contextBundle),
        outputSchema: {},
        lease: { id: "lease", until: "2026-10-30T00:30:00.000Z" },
      },
      contextBundle,
      skills: [{ skillId: "skill", versionHash }],
      files: files.map((f) => ({
        skillId: "skill",
        versionHash,
        path: f.path,
        hash: sha256(f.text),
        contentBase64: Buffer.from(f.text).toString("base64"),
      })),
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "badger-claims-"));
  folders.push(temporary);
  const variables = ["TMPDIR", "TMP", "TEMP"] as const;
  const previous = variables.map((name) => process.env[name]);
  for (const name of variables) process.env[name] = temporary;
  try {
    const { port } = stub.address() as { port: number };
    const server = createEngineerMcp({
      url: `http://127.0.0.1:${port}`,
      token: "secret-token",
      agentHost: "Engineer Agent",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "Engineer Agent", version: "1" });
    clients.push(client);
    await client.connect(a);
    const unsafe = [
      ".git/config",
      "notes/.GIT/HEAD",
      "docs/.Git",
      "tools/.git./config",
      "hfs/.g\u200cit/config",
    ];
    for (const file of unsafe) {
      served = ["SKILL.md", file];
      const refused = await client.callTool({
        name: "claim_job",
        arguments: {
          workflowId: "workflow",
          versionId: "version",
          jobId: "job",
          revision: 1,
        },
      });
      expect(refused.isError, file).toBe(true);
      expect(JSON.stringify(refused.content)).toContain(
        "refuses to write Git metadata",
      );
    }
    expect(releases).toEqual(
      unsafe.map(() => ({
        leaseId: "lease",
        contextHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })),
    );
    expect(await fs.readdir(temporary)).toEqual([]);
  } finally {
    stub.close();
    variables.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

it("reads worker evaluation history and readiness through the Engineer profile while refusing an unscoped token", async () => {
  service = await startTestService({ mode: "local" });
  const { group } = await request("/groups", "POST", { name: "Evaluations" });
  const { workflow, version } = await request("/workflows", "POST", {
    groupId: group.id,
    name: "evaluation-status",
    goal: "Read evaluation history.",
    intent: "new-skill",
    locale: "en",
  });
  const client = await connect();
  const tools = await client.listTools();
  expect(
    tools.tools.find((tool) => tool.name === "evaluation_status")?.annotations
      ?.readOnlyHint,
  ).toBe(true);
  const result = await call(client, "evaluation_status", {
    workflowId: workflow.id,
    versionId: version.id,
  });
  expect(result).toMatchObject({
    currentPackageHash: null,
    reports: [],
    jobs: [],
    passingReportId: null,
  });
  expect(result.dashboard).toContain(
    `/evaluations?workflow=${workflow.id}&version=${version.id}`,
  );
  const restricted = await connect(["expert"]);
  expect(
    (await restricted.listTools()).tools.map((tool) => tool.name),
  ).not.toContain("evaluation_status");
  expect(
    (
      await restricted.callTool({
        name: "evaluation_status",
        arguments: { workflowId: workflow.id, versionId: version.id },
      })
    ).isError,
  ).toBe(true);
});
