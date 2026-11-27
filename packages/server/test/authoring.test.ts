import { reportLaneOutput } from "./fixtures/authoring.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import type { TestService } from "../src/testing/index.js";
import {
  admin,
  engineer,
  owner,
  startPlanningService,
} from "./fixtures/planning.js";
import { initializedFixture } from "./fixtures/packages.js";

let service: TestService;
afterEach(async () => service?.close());

async function generated() {
  service = await startPlanningService();
  const fixture = await initializedFixture(service);
  const { call, base, approve } = fixture;
  const before = await call(`${base}/package`);
  const { confirmation } = await approve("generation");
  await call(
    `${base}/package/generate`,
    "POST",
    {
      confirmed: true,
      confirmationHash: confirmation.confirmationHash,
      stateHash: before.currentStateHash,
      requestId: "generate-authoring",
    },
    engineer,
    202,
  );
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  return fixture;
}

it("dispatches package implementation, reviews the patch, regenerates its exact bytes and verifies the finding", async () => {
  const { call, base, approve } = await generated();
  const { jobs: lanes } = await call(
    base + "/package/authoring-jobs",
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "Finding implementation", scopes: ["engineer"] },
    engineer,
    201,
  );
  const jobsPath = base + "/drafting-jobs/";
  const findingsPath = base + "/package/findings";
  const disposition = {
    subject: "Render the page count",
    route: "implementation",
    target: "implementation/page-count.mjs",
    authority: "The reviewed export requires a page count",
    acceptance: "A three-page fixture reports three pages",
  };
  const fresh = () => call(findingsPath);
  const post = async (action: Record<string, unknown>) =>
    call(findingsPath, "POST", {
      ...action,
      hash: (await fresh()).hash,
      confirmed: true,
      requestId: crypto.randomUUID(),
    });
  async function submit(
    job: { id: string; revision: number },
    resultFrom: (context: any) => Record<string, unknown>,
  ) {
    const path = jobsPath + job.id;
    const claim = await call(
      path + "/claim",
      "POST",
      { revision: job.revision },
      engineer,
      200,
      secret,
    );
    const result = resultFrom(claim.contextBundle);
    if ("implementation" in result) {
      for (const forbidden of [
        "packages/server/src/findings.ts",
        "implementation/../packages/kernel/src/index.ts",
        "scripts/workflow-guard.mjs",
        "implementation/unassigned.mjs",
      ]) {
        await call(
          path + "/submit",
          "POST",
          {
            leaseId: claim.job.lease.id,
            contextHash: claim.job.contextHash,
            result: {
              implementation: {
                summary: "Out-of-scope change",
                tests: "fixture",
                changes: [
                  { path: forbidden, previousHash: null, content: "fixture" },
                ],
              },
            },
          },
          engineer,
          400,
          secret,
        );
      }
    }
    const submitted = await call(
      path + "/submit",
      "POST",
      {
        leaseId: claim.job.lease.id,
        contextHash: claim.job.contextHash,
        result,
      },
      engineer,
      200,
      secret,
    );
    return { path, result, revision: submitted.job.revision };
  }
  async function accept(submitted: Awaited<ReturnType<typeof submit>>) {
    const body = { ...submitted.result, revision: submitted.revision };
    const { preview } = await call(
      submitted.path + "/accept-preview",
      "POST",
      body,
    );
    return call(submitted.path + "/accept", "POST", {
      ...body,
      confirmed: true,
      requestId: crypto.randomUUID(),
      confirmationHash: preview.confirmationHash,
    });
  }
  for (const lane of lanes) {
    await submit(lane, (context) => ({
      laneOutput:
        lane.laneId === "pause-points"
          ? reportLaneOutput(context)
          : {
              schemaVersion: 2,
              lane: lane.laneId,
              status: "BLOCKED",
              summary: "A package checker is missing.",
              semanticDossierHash: context.authoring.plan.semanticDossierHash,
              findings: [
                {
                  severity: "important",
                  problem: "The page count checker has no implementation.",
                  fix: "Add the page count checker.",
                  evidence: [context.authoring.handoff.commonInputPath + ":1"],
                  disposition,
                },
              ],
            },
    }));
  }
  const observed = await fresh();
  expect(observed.observations).toHaveLength(2);
  expect(observed.findings).toHaveLength(1);
  expect(
    (await call(base + "/drafting-jobs")).jobs.filter(
      (job: any) => job.planRepair,
    ),
  ).toHaveLength(0);
  const findingId = observed.findings[0].id;
  await post({
    action: "group",
    observationIds: observed.observations.map(
      (observation: any) => observation.id,
    ),
    findingId,
    disposition,
  });
  const dispatch = { action: "dispatch", findingIds: [findingId] };
  const dispatchRequest = {
    ...dispatch,
    confirmed: true,
    hash: (await fresh()).hash,
    requestId: crypto.randomUUID(),
  };
  const [first, retry] = await Promise.all([
    call(findingsPath, "POST", dispatchRequest),
    call(findingsPath, "POST", dispatchRequest),
  ]);
  expect(retry.jobIds).toEqual(first.jobIds);
  const original = first.jobIds[0];
  const regroup = {
    action: "group",
    findingId,
    observationIds: observed.observations.map(
      (observation: { id: string }) => observation.id,
    ),
  };
  await post({
    ...regroup,
    disposition: { ...disposition, route: "badger", target: "generator" },
  });
  expect((await call(jobsPath + original)).job.status).toBe("cancelled");
  await call(
    findingsPath,
    "POST",
    {
      ...dispatch,
      confirmed: true,
      hash: (await fresh()).hash,
      requestId: crypto.randomUUID(),
    },
    engineer,
    400,
  );
  await post({ ...regroup, disposition });
  const { jobIds } = await post(dispatch);
  expect(jobIds).not.toContain(original);
  expect((await post(dispatch)).jobIds).toEqual(jobIds);
  const job = (await call(jobsPath + jobIds[0])).job;
  expect(job.kind).toBe("implement-finding");
  const content = "export const countPages = (pages) => pages.length;\n";
  await accept(
    await submit(job, (context) => {
      expect(context.findingWork.observations).toHaveLength(2);
      const citation = context.findingWork.observations[0].evidenceFiles[0];
      expect(context.findingWork.files).toContainEqual(
        expect.objectContaining({ path: citation.path, hash: citation.hash }),
      );
      return {
        implementation: {
          summary: "Package page counter",
          changes: [{ path: disposition.target, previousHash: null, content }],
          tests: "The three-page fixture returned three.",
        },
      };
    }),
  );
  const reviewed = await fresh();
  const hash = createHash("sha256").update(content).digest("hex");
  expect(reviewed.findings[0]).toMatchObject({
    status: "awaiting-evidence",
    subjectHash: hash,
  });
  expect((await post(dispatch)).jobIds).toEqual(jobIds);
  const before = await call(base + "/package");
  const { confirmation } = await approve("generation");
  await call(
    base + "/package/generate",
    "POST",
    {
      confirmed: true,
      confirmationHash: confirmation.confirmationHash,
      stateHash: before.currentStateHash,
      requestId: "regenerate-implementation",
    },
    engineer,
    202,
  );
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  const generatedPackage = await call(base + "/package");
  expect(generatedPackage.package.files).toContainEqual(
    expect.objectContaining({ path: disposition.target, sha256: hash }),
  );
  expect((await post(dispatch)).jobIds).toEqual(jobIds);
  const { jobIds: verificationJobs } = await post({
    ...dispatch,
    kind: "verify-finding",
  });
  const verify = (await call(jobsPath + verificationJobs[0])).job;
  await accept(
    await submit(verify, (context) => {
      const snapshot = context.findingWork.verificationPackage;
      const file = snapshot.files.find(
        (file: { path: string }) => file.path === disposition.target,
      );
      const candidate = Buffer.from(file.content, "base64").toString("utf8");
      expect(candidate).toBe(content);
      const observed = execFileSync(process.execPath, ["--input-type=module"], {
        input:
          candidate +
          "\nconsole.log(countPages(['page one','page two','page three']));",
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      expect(observed).toBe("3");
      return {
        verification: {
          subjectHash: context.findingWork.subjectHash,
          outcome: "passed",
          fixture: "three synthetic pages",
          environment: "Node " + process.versions.node,
          evidence: "expected 3, observed " + observed,
        },
      };
    }),
  );
  expect((await fresh()).findings[0]).toMatchObject({
    status: "verified",
    verified_hash: hash,
  });
  for (let wave = 0; wave < 3; wave++) {
    const { jobs } = await call(
      base + "/package/authoring-jobs",
      "POST",
      { confirmed: true },
      engineer,
      201,
    );
    for (const lane of jobs) {
      await accept(
        await submit(lane, (context) => {
          if (lane.laneId === "script") {
            expect(context.authoring.findingHistory).toContainEqual(
              expect.objectContaining({ id: findingId, status: "verified" }),
            );
            const history = context.authoring.findingHistory.find(
              (item: any) => item.id === findingId,
            );
            for (const observation of history.observations) {
              const cited = observation.evidenceFiles[0];
              const file = context.authoring.files.find(
                (input: any) => input.path === cited.path,
              );
              expect(createHash("sha256").update(file.text).digest("hex")).toBe(
                cited.hash,
              );
            }
            expect(history.work).toContainEqual(
              expect.objectContaining({
                verification: expect.objectContaining({ outcome: "passed" }),
              }),
            );
            expect(context.authoring.files).toContainEqual({
              path: "inputs/package/" + disposition.target,
              text: content,
              hash,
            });
          }
          return { laneOutput: reportLaneOutput(context) };
        }),
      );
    }
  }
  const { preview } = await call(
    base + "/package/assemble-preview",
    "POST",
    {},
  );
  const assembled = await call(base + "/package/assemble", "POST", {
    confirmed: true,
    requestId: "assemble-accepted-patch",
    confirmationHash: preview.confirmationHash,
  });
  expect(assembled.packageHash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (
      await call(
        base + "/package/file?path=" + encodeURIComponent(disposition.target),
      )
    ).text,
  ).toBe(content);
  await post({
    ...regroup,
    disposition: { ...disposition, environment: "Node 24 offline" },
  });
  expect((await fresh()).findings[0].status).toBe("recheck");
  const recheck = await post({ ...dispatch, kind: "verify-finding" });
  expect(recheck.jobIds).not.toEqual(verificationJobs);
}, 90000);

it("keeps mixed Plan and pinned Skill work independent, then imports the reviewed Skill candidate", async () => {
  const { base, call, skill } = await generated();
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "Mixed package findings", scopes: ["engineer"] },
    engineer,
    201,
  );
  const { jobs: lanes } = await call(
    base + "/package/authoring-jobs",
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const path = base + "/drafting-jobs/";
  const findings = base + "/package/findings";
  const planWork = {
    route: "plan",
    subject: "Correct the default",
    target: "/workflow/customNodes/0/label",
    acceptance: "Label describes the existing approved behavior",
    authority: "Approved workflow Dossier",
  };
  const skillWork = {
    route: "implementation",
    subject: "Package Skill helper",
    sourceSkillId: skill.id,
    target: "scripts/pages.mjs",
    acceptance: "Can count three pages",
    authority: "Approved report scope",
  };
  const report = lanes.find((job: any) => job.laneId === "script");
  const claim = await call(
    path + report.id + "/claim",
    "POST",
    { revision: report.revision },
    engineer,
    200,
    secret,
  );
  await call(
    path + report.id + "/submit",
    "POST",
    {
      leaseId: claim.job.lease.id,
      contextHash: claim.job.contextHash,
      result: {
        laneOutput: {
          schemaVersion: 2,
          lane: "script",
          status: "BLOCKED",
          summary: "The label and helper require different changes",
          semanticDossierHash:
            claim.contextBundle.authoring.plan.semanticDossierHash,
          findings: [planWork, skillWork].map((disposition) => ({
            severity: "important",
            problem: disposition.subject,
            fix: disposition.acceptance,
            disposition,
          })),
        },
      },
    },
    engineer,
    200,
    secret,
  );
  const command = async (action: Record<string, unknown>) =>
    call(findings, "POST", {
      ...action,
      hash: (await call(findings)).hash,
      confirmed: true,
      requestId: crypto.randomUUID(),
    });
  const view = await call(findings);
  for (const observation of view.observations) {
    await command({
      action: "group",
      observationIds: [observation.id],
      findingId: observation.finding_ids[0],
      disposition: observation.finding.disposition,
    });
  }
  const dispatched = await command({
    action: "dispatch",
    findingIds: view.findings.map((item: any) => item.id),
  });
  const jobs = (await call(base + "/drafting-jobs")).jobs.filter((job: any) =>
    dispatched.jobIds.includes(job.id),
  );
  const planJob = jobs.find((job: any) => job.kind === "draft-plan");
  expect(planJob.planRepair.items.map((item: any) => item.description)).toEqual(
    [planWork.subject],
  );
  const implement = jobs.find((job: any) => job.kind === "implement-finding");
  const source = await call(
    path + implement.id + "/claim",
    "POST",
    { revision: implement.revision },
    engineer,
    200,
    secret,
  );
  expect(source.contextBundle.findingWork.sourcePin.skillId).toBe(skill.id);
  const changed = "export const pages = items => items.length;\n";
  const result = {
    implementation: {
      summary: "Add the package Skill helper",
      tests: "Three pages returned",
      changes: [
        { path: skillWork.target, previousHash: null, content: changed },
      ],
    },
  };
  const { job: submitted } = await call(
    path + implement.id + "/submit",
    "POST",
    {
      result,
      leaseId: source.job.lease.id,
      contextHash: source.job.contextHash,
    },
    engineer,
    200,
    secret,
  );
  const body = { ...result, revision: submitted.revision };
  const { preview } = await call(
    path + implement.id + "/accept-preview",
    "POST",
    body,
  );
  await call(path + implement.id + "/accept", "POST", {
    ...body,
    confirmed: true,
    requestId: "accept-source-patch",
    confirmationHash: preview.confirmationHash,
  });
  const candidate = (await call(findings)).work.find(
    (item: any) => item.id === implement.id,
  ).source_candidate;
  const changes = {
    baseHash: candidate.hash,
    changes: [
      {
        path: skillWork.target,
        content: Buffer.from(changed).toString("base64"),
      },
    ],
  };
  const { preview: sourcePreview } = await call(
    "/skills/" + skill.id + "/upload-preview",
    "POST",
    changes,
  );
  expect(sourcePreview.hash).toBe(candidate.candidateHash);
  await call(
    "/skills/" + skill.id + "/versions",
    "POST",
    {
      ...changes,
      confirmed: true,
      expectedHash: sourcePreview.hash,
      confirmationHash: sourcePreview.confirmationHash,
    },
    engineer,
    201,
  );
  await call(base + "/pins", "POST", {
    skillId: skill.id,
    hash: sourcePreview.hash,
    purpose: candidate.purpose,
    revision: candidate.revision,
  });
  expect((await call(base + "/pins")).pins[0].hash).toBe(sourcePreview.hash);
}, 45000);

it("dispatches a finding about a Node's instructions to Skill Core with the originating evidence", async () => {
  const fixture = await generated();
  const { base, call } = fixture;
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "Lane revision", scopes: ["engineer"] },
    engineer,
    201,
  );
  const { jobs } = await call(
    base + "/package/authoring-jobs",
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const script = jobs.find((job: any) => job.laneId === "script");
  await acceptLane(fixture, secret, script, reportLaneOutput);
  const disposition = {
    subject: "Explain the Node recovery step",
    route: "lane",
    target: "skill-core",
    authority: "Approved Node responsibility",
    acceptance: "Node instructions name the recovery input",
  };
  const reference = jobs.find((job: any) => job.laneId === "reference");
  await acceptLane(fixture, secret, reference, (context) => ({
    schemaVersion: 2,
    lane: "reference",
    status: "BLOCKED",
    summary: disposition.subject,
    semanticDossierHash: context.authoring.plan.semanticDossierHash,
    findings: [
      {
        severity: "important",
        problem: disposition.subject,
        fix: disposition.acceptance,
        disposition,
        evidence: [context.authoring.handoff.commonInputPath],
      },
    ],
  }));
  const url = base + "/package/findings";
  const view = await call(url);
  const action = async (data: Record<string, unknown>) =>
    call(url, "POST", {
      ...data,
      hash: (await call(url)).hash,
      requestId: crypto.randomUUID(),
      confirmed: true,
    });
  const { findingId } = await action({
    action: "group",
    observationIds: [view.observations[0].id],
    disposition,
  });
  const { jobIds } = await action({
    action: "dispatch",
    findingIds: [findingId],
  });
  const { job } = await call(base + "/drafting-jobs/" + jobIds[0]);
  expect(job).toMatchObject({ kind: "authoring-lane", laneId: "skill-core" });
  await acceptLane(fixture, secret, job, (context) => {
    expect(context.findingWork.findingIds).toEqual([findingId]);
    expect(
      context.authoring.findingHistory[0].observations[0].evidenceFiles,
    ).toHaveLength(1);
    return reportLaneOutput(context);
  });
}, 45000);

/** An Agent drafts a lane result with a token; the signed-in Engineer accepts it. */
async function acceptLane(
  { call, base }: Awaited<ReturnType<typeof generated>>,
  secret: string,
  job: { id: string; revision: number },
  draft: (context: any) => unknown,
) {
  const route = `${base}/drafting-jobs/${job.id}`;
  const claim = await call(
    `${route}/claim`,
    "POST",
    { revision: job.revision },
    engineer,
    200,
    secret,
  );
  const laneOutput = draft(claim.contextBundle);
  const { job: submitted } = await call(
    `${route}/submit`,
    "POST",
    {
      leaseId: claim.job.lease.id,
      contextHash: claim.job.contextHash,
      result: { laneOutput },
    },
    engineer,
    200,
    secret,
  );
  const decision = { revision: submitted.revision, laneOutput };
  const { preview } = await call(`${route}/accept-preview`, "POST", decision);
  return call(`${route}/accept`, "POST", {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: `accept-${job.id}`,
  });
}

it("reports Markdown findings for both pause-points leaves before handoff and review", async () => {
  const { call, base } = await generated();
  const { jobs } = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const pausePoints = jobs.find((job: any) => job.laneId === "pause-points");
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "pause-points author", scopes: ["engineer"] },
    engineer,
    201,
  );
  const route = `${base}/drafting-jobs/${pausePoints.id}`;
  const claim = await call(
    `${route}/claim`,
    "POST",
    { revision: pausePoints.revision },
    engineer,
    200,
    secret,
  );
  const valid = reportLaneOutput(claim.contextBundle);
  const invalid = {
    ...valid,
    artifacts: valid.artifacts.map(
      (artifact: { path: string; content: string }) => ({
        ...artifact,
        content: artifact.content
          .replace("## Classification", "## Categories")
          .replace("## Drift Handling", "## Recover stale evidence"),
      }),
    ),
  };
  const lease = {
    leaseId: claim.job.lease.id,
    contextHash: claim.job.contextHash,
  };
  const findings = [
    "authored content missing substantive section Classification: reference/decision-points.md",
    "authored content missing substantive section Drift Handling: reference/recovery.md",
  ];
  const rejected = await call(
    `${route}/submit`,
    "POST",
    { ...lease, result: { laneOutput: invalid }, keepClaim: true },
    engineer,
    400,
    secret,
  );
  expect(rejected.findings).toEqual(findings);
  const { job: saved } = await call(
    `${route}/submit`,
    "POST",
    { ...lease, result: { laneOutput: valid }, keepClaim: true },
    engineer,
    200,
    secret,
  );
  expect(saved.status).toBe("claimed");
  const { job: submitted } = await call(
    `${route}/finish`,
    "POST",
    { ...lease, revision: saved.revision },
    engineer,
    200,
    secret,
  );
  const rejectedPreview = await call(
    `${route}/accept-preview`,
    "POST",
    { revision: submitted.revision, laneOutput: invalid },
    engineer,
    400,
  );
  expect(rejectedPreview.findings).toEqual(findings);
  await call(`${route}/accept-preview`, "POST", {
    revision: submitted.revision,
    laneOutput: valid,
  });
  expect(claim.instructions).toContain("## Classification");
  expect(claim.instructions).toContain("## Drift Handling");
});

it("retains concern details and requests a revision with the fixed handoff", async () => {
  const fixture = await generated();
  const { call, base } = fixture;
  const { jobs } = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "script author", scopes: ["engineer"] },
    engineer,
    201,
  );
  const finding = {
    severity: "minor",
    problem: "The previous handoff omitted its shared brief.",
    path: "reference/authoring-subagents.md",
    owner: "Badger handoff",
    fix: "Read the shared brief from the revised handoff.",
  };
  const script = jobs.find((job: any) => job.laneId === "script");
  await acceptLane(fixture, secret, script, (context) => ({
    ...reportLaneOutput(context),
    status: "DONE_WITH_CONCERNS",
    findings: [finding],
  }));
  const view = await call(`${base}/package/authoring`);
  const record = view.readiness.records.script;
  expect(record.findings).toEqual([finding]);
  expect(view.readiness.completedLanes).not.toContain("script");
  const revised = {
    confirmed: true,
    lane: "script",
    authoringRevision: record.revision,
  };
  await call(
    `${base}/package/authoring-jobs`,
    "POST",
    {
      ...revised,
      authoringRevision: record.revision + 1,
    },
    engineer,
    409,
  );
  const {
    jobs: [retry],
  } = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    revised,
    engineer,
    201,
  );
  const claimed = await call(
    `${base}/drafting-jobs/${retry.id}/claim`,
    "POST",
    { revision: retry.revision },
    engineer,
    200,
    secret,
  );
  const bundle = claimed.contextBundle.authoring;
  expect(bundle.priorFindings).toEqual([finding]);
  const shared = bundle.files.find(
    (file: { path: string }) => file.path === bundle.handoff.sharedBriefPath,
  );
  expect(shared.text).toContain("# Authoring Handoffs");
  expect(createHash("sha256").update(shared.text).digest("hex")).toBe(
    shared.hash,
  );
  const duplicate = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    revised,
    engineer,
    201,
  );
  expect(duplicate.jobs).toEqual([]);
});

it("groups the finished wave into one claimable Plan repair, validates every finding and returns feedback to the agent", async () => {
  const fixture = await generated();
  const { call, base } = fixture;
  const planBefore = await call(base + "/plan");
  const { jobs: lanes } = await call(
    base + "/package/authoring-jobs",
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "Wave agents", scopes: ["engineer"] },
    engineer,
    201,
  );
  const all = async () => (await call(base + "/drafting-jobs")).jobs;
  const repairs = async () =>
    (await all()).filter((job: any) => job.planRepair);
  const handoffs = [];
  for (const lane of lanes) {
    const route = base + "/drafting-jobs/" + lane.id;
    const claim = await call(
      route + "/claim",
      "POST",
      { revision: lane.revision },
      engineer,
      200,
      secret,
    );
    const result = {
      laneOutput:
        lane.laneId === "pause-points"
          ? reportLaneOutput(claim.contextBundle)
          : {
              lane: lane.laneId,
              status: "BLOCKED",
              semanticDossierHash:
                claim.contextBundle.authoring.plan.semanticDossierHash,
              summary: "Repair the reviewed report.",
              findings: [
                {
                  severity: "important",
                  problem: lane.laneId + " evidence is missing.",
                },
              ],
              action: {
                kind: "repair",
                target: { stage: "plan" },
                requirement: "Update the report contract.",
                prompt: "Bind " + lane.laneId + " evidence.",
              },
            },
    };
    const lease = {
      leaseId: claim.job.lease.id,
      contextHash: claim.job.contextHash,
    };
    await call(
      route + "/submit",
      "POST",
      { ...lease, result, keepClaim: true },
      engineer,
      200,
      secret,
    );
    handoffs.push({ route, lease, result, lane });
  }
  await call(
    handoffs[0]!.route + "/finish",
    "POST",
    handoffs[0]!.lease,
    engineer,
    200,
    secret,
  );
  expect(await repairs()).toHaveLength(0);
  await Promise.all(
    handoffs
      .slice(1)
      .map(({ route, lease }) =>
        call(route + "/finish", "POST", lease, engineer, 200, secret),
      ),
  );
  const [repair] = await repairs();
  expect(await repairs()).toHaveLength(1);
  expect(repair.planRepair.items.map((item: any) => item.source)).toEqual([
    "script",
    "reference",
  ]);
  expect(
    (await all())
      .filter((job: any) => job.laneId)
      .every((job: any) => job.status === "submitted"),
  ).toBe(true);
  expect((await call(base + "/package/authoring")).planRepairs).toEqual([
    { id: repair.id, wave: "wave1", status: "queued" },
  ]);
  const script = handoffs.find((item) => item.lane.laneId === "script")!;
  const sourceDecision = {
    revision: (await call(script.route)).job.revision,
    ...script.result,
  };
  const lanePreview = await call(
    script.route + "/accept-preview",
    "POST",
    sourceDecision,
  );
  const laneConfirm = {
    ...sourceDecision,
    confirmed: true,
    confirmationHash: lanePreview.preview.confirmationHash,
    requestId: "accept-script-report",
  };
  const laneAccepted = await call(
    script.route + "/accept",
    "POST",
    laneConfirm,
  );
  expect(laneAccepted.job.decision.followUp.planDraftId).toBe(repair.id);
  expect(await call(script.route + "/accept", "POST", laneConfirm)).toEqual(
    laneAccepted,
  );
  const route = base + "/drafting-jobs/" + repair.id;
  expect((await call(route + "/prompt")).prompt).toContain("script, reference");
  const claim = await call(
    route + "/claim",
    "POST",
    { revision: repair.revision },
    engineer,
    200,
    secret,
  );
  expect(claim.contextBundle.planRepair.basePlan.id).toBe(
    planBefore.currentVersionId,
  );
  expect(claim.instructions).toContain("already-covered");
  const plan = structuredClone(claim.contextBundle.planRepair.basePlan.plan);
  plan.workflow.customNodes[0].label = "Review both sources";
  const resolutions = Object.fromEntries(
    repair.planRepair.items.map((item: any) => [
      item.id,
      { status: "addressed", explanation: "See the report Node label." },
    ]),
  );
  const lease = {
    leaseId: claim.job.lease.id,
    contextHash: claim.job.contextHash,
  };
  await call(
    route + "/submit",
    "POST",
    { ...lease, result: { plan, resolutions: {} } },
    engineer,
    400,
    secret,
  );
  const invalid = structuredClone(plan);
  invalid.workflow.customNodes[0].id = "different-node";
  await call(
    route + "/submit",
    "POST",
    { ...lease, result: { plan: invalid, resolutions } },
    engineer,
    409,
    secret,
  );
  const { job: submitted } = await call(
    route + "/submit",
    "POST",
    { ...lease, result: { plan, resolutions } },
    engineer,
    200,
    secret,
  );
  const feedback = {
    revision: submitted.revision,
    reason: "Clarify the reviewer evidence.",
    confirmed: true,
  };
  const returned = await call(route + "/return-plan", "POST", feedback);
  expect(
    (await call(route + "/return-plan", "POST", feedback)).job.revision,
  ).toBe(returned.job.revision);
  expect(await repairs()).toHaveLength(1);
  const next = await call(
    route + "/claim",
    "POST",
    { revision: returned.job.revision },
    engineer,
    200,
    secret,
  );
  expect(next.job.result.plan).toEqual(plan);
  expect(next.instructions).toContain(feedback.reason);
  await call(
    route + "/finish",
    "POST",
    { leaseId: next.job.lease.id, contextHash: next.job.contextHash },
    engineer,
    409,
    secret,
  );
  plan.workflow.customNodes[0].label = "Review both sources and their evidence";
  const revised = await call(
    route + "/submit",
    "POST",
    {
      leaseId: next.job.lease.id,
      contextHash: next.job.contextHash,
      result: { plan, resolutions },
    },
    engineer,
    200,
    secret,
  );
  const decision = { revision: revised.job.revision, plan, resolutions };
  await call(
    route + "/accept-preview",
    "POST",
    { ...decision, plan: claim.contextBundle.planRepair.basePlan.plan },
    engineer,
    409,
  );
  const { preview } = await call(route + "/accept-preview", "POST", decision);
  const confirmation = {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "accept-wave-plan",
  };
  await call(route + "/accept", "POST", confirmation, engineer, 403, secret);
  expect((await call(base + "/plan")).headVersionId).toBe(
    planBefore.headVersionId,
  );
  const accepted = await call(route + "/accept", "POST", confirmation);
  expect(await call(route + "/accept", "POST", confirmation)).toEqual(accepted);
  expect((await call(base + "/plan")).versions[0].snapshot.plan).toEqual(plan);
  expect(await repairs()).toHaveLength(1);
});

it("links accepted Sources, Dossier, and Proposal findings to their exact inputs", async () => {
  const fixture = await generated();
  const { call, base, dossier, skill } = fixture;
  const { jobs } = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "stage follow-ups", scopes: ["engineer"] },
    engineer,
    201,
  );
  const before = await call(`${base}/proposal`);
  const allTargets = (context: any) => {
    const pin = context.pins.find((entry: any) => entry.skillId === skill.id);
    return {
      script: { stage: "sources", skillId: pin.skillId, skillHash: pin.hash },
      reference: { stage: "dossier", field: "/nodes/0/responsibility" },
      "pause-points": { stage: "proposal" },
    };
  };
  const changes = [];
  for (const job of jobs) {
    const { job: accepted } = await acceptLane(
      fixture,
      secret,
      job,
      (context) => ({
        lane: job.laneId,
        status: "BLOCKED",
        semanticDossierHash: context.authoring.plan.semanticDossierHash,
        summary: "The package exposed an issue with an approved input.",
        findings: [
          {
            severity: "important",
            problem: "The current report contract is incomplete.",
          },
        ],
        action: {
          kind: "repair",
          requirement: "Review the incomplete report contract.",
          prompt: "Inspect the missing report evidence in the reviewed input.",
          target:
            allTargets(context)[
              job.laneId as keyof ReturnType<typeof allTargets>
            ],
        },
      }),
    );
    const { finding } = await call(
      `${base}/package/authoring?finding=${job.id}`,
    );
    const target = finding.action.target;
    changes.push(target.stage);
    expect(finding).toMatchObject({
      jobId: job.id,
      findings: [{ problem: "The current report contract is incomplete." }],
      targetHash:
        target.stage === "sources"
          ? target.skillHash
          : target.stage === "dossier"
            ? dossier.hash
            : before.proposal.proposalHash,
    });
    expect(accepted.decision.followUp).toMatchObject({
      stage: target.stage,
      planDraftId: null,
    });
  }
  expect(changes).toEqual(["sources", "dossier", "proposal"]);
  const { jobs: after } = await call(`${base}/drafting-jobs`);
  expect(
    after.filter((job: any) => job.kind === "authoring-lane"),
  ).toHaveLength(3);
  expect(await call(`${base}/proposal`)).toMatchObject({
    proposal: before.proposal,
    confirmation: before.confirmation,
    planVersionHash: before.planVersionHash,
  });
});

it("offers only current Wave lanes as bounded Agent jobs and keeps submitted output out of the authoring session until acceptance", async () => {
  const { call, base } = await generated();
  const { jobs } = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  expect(jobs.map((j: any) => j.laneId)).toEqual([
    "script",
    "reference",
    "pause-points",
  ]);
  for (const job of jobs) {
    const { prompt } = await call(`${base}/drafting-jobs/${job.id}/prompt`);
    expect(prompt).toContain("After saving the final draft, call finish_job");
    expect(prompt).toContain("I authorize this handoff for the final draft");
  }
  const script = jobs.find((j: any) => j.laneId === "script");
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "authoring", scopes: ["engineer"] },
    engineer,
    201,
  );
  const path = `${base}/drafting-jobs/${script.id}`;
  const claimed = await call(
    `${path}/claim`,
    "POST",
    { revision: script.revision },
    engineer,
    200,
    secret,
  );
  expect(claimed.instructions).toContain(
    "The person's copied dispatch prompt can authorize finish_job after the final verified save.",
  );
  expect(claimed.contextBundle.authoring).toMatchObject({
    lane: "script",
    handoff: { capabilities: { writeCreatorState: false } },
  });
  expect(claimed.contextBundle.authoring.files.length).toBeGreaterThan(2);
  expect(
    JSON.stringify(claimed).includes(service.config.storage.workspaceDirectory),
    "Authoring claims must contain only portable paths",
  ).toBe(false);
  const bundle = claimed.contextBundle.authoring;
  const proposal = bundle.files.find(
    (file: { path: string }) =>
      file.path === bundle.handoff.confirmedProposal.path,
  );
  expect(createHash("sha256").update(proposal.text).digest("hex")).toBe(
    bundle.handoff.confirmedProposal.hash,
  );
  const common = bundle.files.find(
    (file: { path: string }) => file.path === bundle.handoff.commonInputPath,
  );
  expect(JSON.parse(common.text).confirmedProposal).toEqual(
    bundle.handoff.confirmedProposal,
  );
  const laneOutput = {
    semanticDossierHash:
      claimed.contextBundle.authoring.plan.semanticDossierHash,
    lane: "script",
    status: "NEEDS_CONTEXT",
    summary: "Clarify report inputs.",
    action: {
      kind: "question",
      prompt: "Which report fields are mandatory?",
      requirement: "/nodes/0/responsibility",
    },
    claims: [],
    artifacts: [],
  };
  const { job: saved } = await call(
    `${path}/submit`,
    "POST",
    {
      leaseId: claimed.job.lease.id,
      contextHash: claimed.job.contextHash,
      result: { laneOutput },
      keepClaim: true,
    },
    engineer,
    200,
    secret,
  );
  expect(saved.status).toBe("claimed");
  const { job: submitted } = await call(
    `${path}/finish`,
    "POST",
    {
      leaseId: claimed.job.lease.id,
      contextHash: claimed.job.contextHash,
      revision: saved.revision,
    },
    engineer,
    200,
    secret,
  );
  expect(submitted).toMatchObject({
    status: "submitted",
    lease: null,
    currentResultHash: saved.currentResultHash,
  });
  expect(
    (await call(`${base}/package/authoring`)).readiness.records.script,
  ).toBeUndefined();
  const decision = { revision: submitted.revision, laneOutput };
  const { preview } = await call(`${path}/accept-preview`, "POST", decision);
  await call(`${path}/accept`, "POST", {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "accept-script",
  });
  const view = await call(`${base}/package/authoring`);
  expect(view.readiness.records.script).toMatchObject({
    status: "NEEDS_CONTEXT",
    revision: 2,
  });
  expect(view.followUps).toContainEqual(
    expect.objectContaining({
      laneId: "script",
      questionId: expect.any(String),
    }),
  );
  // NEEDS_CONTEXT pauses every lane, not only the one that reported it: the
  // kernel dispatches none, and the draft question withdraws the package.
  expect(view.readiness.state).toBe("needs-context");
  const { jobs: drafts } = await call(`${base}/drafting-jobs`);
  expect(
    drafts.filter((j: any) => j.laneId !== "script").map((j: any) => j.status),
  ).toEqual(["cancelled", "cancelled"]);
  expect((await call(`${base}/package`)).package.status).toBe("invalidated");
  await call(
    `${base}/package/authoring-jobs`,
    "POST",
    { confirmed: true },
    engineer,
    409,
  );
  await call(`${base}/package/assemble-preview`, "POST", {}, engineer, 409);
});

it.each(["skill-core", "skill-review"])(
  "accepts NEEDS_CONTEXT from %s without a lane action and drafts its follow-up question from the summary",
  async (lane) => {
    const fixture = await generated();
    const { call, base } = fixture;
    const { secret } = await call(
      "/me/tokens",
      "POST",
      { name: "context", scopes: ["engineer"] },
      engineer,
      201,
    );
    const summary = `Which report audience should ${lane} address?`;
    let accepted;
    for (let wave = 0; wave < 3 && !accepted; wave++) {
      const { jobs } = await call(
        `${base}/package/authoring-jobs`,
        "POST",
        { confirmed: true },
        engineer,
        201,
      );
      for (const job of jobs) {
        if (job.laneId !== lane) {
          await acceptLane(fixture, secret, job, reportLaneOutput);
          continue;
        }
        // The kernel requires a question action only from Wave 1 lanes.
        accepted = await acceptLane(fixture, secret, job, (context) => ({
          lane,
          status: "NEEDS_CONTEXT",
          semanticDossierHash: context.authoring.plan.semanticDossierHash,
          summary,
          claims: [],
          artifacts: [],
        }));
      }
    }
    expect(accepted.job.status).toBe("accepted");
    const view = await call(`${base}/package/authoring`);
    expect(view.readiness.records[lane]).toMatchObject({
      status: "NEEDS_CONTEXT",
    });
    const followUp = view.followUps.find((f: any) => f.laneId === lane);
    expect(followUp).toMatchObject({
      questionId: expect.any(String),
      repairJobId: null,
    });
    const { rounds, questions } = await call(`${base}/questionnaire`);
    const question = questions.find((q: any) => q.id === followUp.questionId);
    expect(question).toMatchObject({
      text: summary,
      rationale: `The ${lane} Authoring lane reported NEEDS_CONTEXT without naming a dossier field.`,
    });
    expect(rounds.find((r: any) => r.id === question.roundId)).toMatchObject({
      title: `Authoring: ${lane}`,
      state: "draft",
    });
  },
);

it("records accepted lanes in revision order, unlocks dependent jobs and review votes, then confirms assembly for the exact session", async () => {
  const { call, base } = await generated();
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "lanes", scopes: ["engineer"] },
    engineer,
    201,
  );
  const accepted: string[] = [];
  for (let wave = 0; wave < 3; wave++) {
    const { jobs } = await call(
      `${base}/package/authoring-jobs`,
      "POST",
      { confirmed: true },
      engineer,
      201,
    );
    expect(jobs.length).toBeGreaterThan(0);
    if (wave === 2)
      expect(jobs[0]).toMatchObject({
        kind: "review-vote",
        laneId: "skill-review",
      });
    for (const job of jobs) {
      const route = `${base}/drafting-jobs/${job.id}`;
      const claim = await call(
        `${route}/claim`,
        "POST",
        { revision: job.revision },
        engineer,
        200,
        secret,
      );
      const laneOutput = reportLaneOutput(claim.contextBundle);
      const { job: submitted } = await call(
        `${route}/submit`,
        "POST",
        {
          leaseId: claim.job.lease.id,
          contextHash: claim.job.contextHash,
          result: { laneOutput },
        },
        engineer,
        200,
        secret,
      );
      const decision = { revision: submitted.revision, laneOutput };
      const { preview } = await call(
        `${route}/accept-preview`,
        "POST",
        decision,
      );
      await call(`${route}/accept`, "POST", {
        ...decision,
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: `accept-${job.laneId}`,
      });
      accepted.push(job.laneId);
      const view = await call(`${base}/package/authoring`);
      expect(view.readiness.records[job.laneId].revision).toBe(
        accepted.length + 1,
      );
    }
  }
  expect(accepted).toEqual([
    "script",
    "reference",
    "pause-points",
    "workflow-entry",
    "skill-core",
    "skill-review",
  ]);
  const { preview } = await call(
    `${base}/package/assemble-preview`,
    "POST",
    {},
  );
  await call(
    `${base}/package/assemble`,
    "POST",
    {
      confirmed: false,
      confirmationHash: preview.confirmationHash,
      requestId: "assembly",
    },
    engineer,
    400,
  );
  const result = await call(`${base}/package/assemble`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "assembly",
  });
  expect(result.packageHash).toMatch(/^[a-f0-9]{64}$/u);
  const assembled = await call(`${base}/package`);
  expect(assembled.package.assembledHash).toBe(result.packageHash);
  expect((await call(`${base}/package/file?path=SKILL.md`)).text).toContain(
    "A topic change requires",
  );
  expect((await call(`${base}/package/file?path=SKILL.md`)).text).not.toContain(
    "AUTHORING PENDING",
  );
  expect((await call(`${base}/package/authoring`)).readiness.status).toBe(
    "assembled",
  );
  expect(
    await call(`${base}/package/assemble`, "POST", {
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: "assembly",
    }),
  ).toEqual(result);
});

it("keeps server storage paths out of every package-stage read model a token can read", async () => {
  const fixture = await generated();
  const { call, base, workflow } = fixture;
  const reviewer = { subject: "reviewer", email: "reviewer@example.com" };
  await call(
    "/bindings",
    "POST",
    {
      scopeType: "workflow",
      scopeId: workflow.id,
      email: reviewer.email,
      role: "Workflow owner",
    },
    admin,
    201,
  );
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "paths", scopes: ["engineer"] },
    engineer,
    201,
  );
  const read = async (route: string) =>
    expect(
      JSON.stringify(
        await call(route, "GET", undefined, engineer, 200, secret),
      ),
      route,
    ).not.toContain(service.config.storage.workspaceDirectory);
  const readStage = async () => {
    for (const route of [
      "package",
      "package/authoring",
      "evaluations",
      "review",
    ])
      await read(`${base}/${route}`);
  };
  await readStage();
  for (let wave = 0; wave < 3; wave++) {
    const { jobs } = await call(
      `${base}/package/authoring-jobs`,
      "POST",
      { confirmed: true },
      engineer,
      201,
    );
    for (const job of jobs)
      await acceptLane(fixture, secret, job, reportLaneOutput);
    await readStage();
  }
  const { preview } = await call(
    `${base}/package/assemble-preview`,
    "POST",
    {},
  );
  const { packageHash } = await call(`${base}/package/assemble`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "assemble-paths",
  });
  await readStage();
  await call(
    `${base}/evaluations`,
    "POST",
    { confirmed: true, packageHash, requestId: "evaluate-paths" },
    engineer,
    202,
  );
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  await readStage();
  const { preview: approval } = await call(
    `${base}/review/approve-preview`,
    "POST",
    {},
    reviewer,
  );
  await call(
    `${base}/review/approve`,
    "POST",
    {
      confirmed: true,
      confirmationHash: approval.confirmationHash,
      requestId: "approve-paths",
    },
    reviewer,
  );
  const { preview: publication } = await call(
    `${base}/review/publish-preview`,
    "POST",
    {},
    owner,
  );
  const published = await call(
    `${base}/review/publish`,
    "POST",
    {
      confirmed: true,
      confirmationHash: publication.confirmationHash,
      requestId: "publish-paths",
    },
    owner,
  );
  await readStage();
  const publications = `/workflows/${workflow.id}/publications`;
  await read(publications);
  await read(`${publications}/${published.confirmation.id}/package`);
}, 90_000);

it("returns a rejected lane with its reason, turns BLOCKED into a linked repair job, and refuses Agent sign-off", async () => {
  const { call, base } = await generated();
  const { jobs } = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "repair", scopes: ["engineer"] },
    engineer,
    201,
  );
  const first = jobs[0],
    route = `${base}/drafting-jobs/${first.id}`;
  const claim = await call(
    `${route}/claim`,
    "POST",
    { revision: first.revision },
    engineer,
    200,
    secret,
  );
  const laneOutput = {
    lane: first.laneId,
    status: "BLOCKED",
    semanticDossierHash: claim.contextBundle.authoring.plan.semanticDossierHash,
    claims: [],
    artifacts: [],
    summary: "The declared evidence cannot be produced.",
    action: {
      kind: "repair",
      prompt: "Repair the report evidence mapping.",
      requirement: "Match the approved report evidence.",
    },
  };
  const { job: submitted } = await call(
    `${route}/submit`,
    "POST",
    {
      leaseId: claim.job.lease.id,
      contextHash: claim.job.contextHash,
      result: { laneOutput },
    },
    engineer,
    200,
    secret,
  );
  await call(
    `${route}/accept-preview`,
    "POST",
    { revision: submitted.revision, laneOutput },
    engineer,
    403,
    secret,
  );
  const decision = {
    revision: submitted.revision,
    reason: "The missing evidence has not been identified.",
  };
  const { preview } = await call(`${route}/reject-preview`, "POST", decision);
  const rejected = await call(`${route}/reject`, "POST", {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "reject-lane",
  });
  expect(rejected.job).toMatchObject({
    status: "rejected",
    decision: { decision: { reason: decision.reason } },
  });
  expect(
    (await call(`${base}/package/authoring`)).readiness.records[first.laneId],
  ).toBeUndefined();
  const retry = (
    await call(
      `${base}/package/authoring-jobs`,
      "POST",
      { confirmed: true },
      engineer,
      201,
    )
  ).jobs[0];
  const retryRoute = `${base}/drafting-jobs/${retry.id}`;
  const retryClaim = await call(
    `${retryRoute}/claim`,
    "POST",
    { revision: retry.revision },
    engineer,
    200,
    secret,
  );
  const { job: blocked } = await call(
    `${retryRoute}/submit`,
    "POST",
    {
      leaseId: retryClaim.job.lease.id,
      contextHash: retryClaim.job.contextHash,
      result: { laneOutput },
    },
    engineer,
    200,
    secret,
  );
  const accepted = { revision: blocked.revision, laneOutput };
  const acceptedPreview = await call(
    `${retryRoute}/accept-preview`,
    "POST",
    accepted,
  );
  await call(`${retryRoute}/accept`, "POST", {
    ...accepted,
    confirmed: true,
    confirmationHash: acceptedPreview.preview.confirmationHash,
    requestId: "accept-blocked",
  });
  const view = await call(`${base}/package/authoring`);
  expect(view.followUps).toContainEqual(
    expect.objectContaining({
      laneId: first.laneId,
      repairJobId: expect.any(String),
      questionId: null,
    }),
  );
  expect(
    view.jobs.filter(
      (j: any) => j.laneId === first.laneId && j.status === "queued",
    ),
  ).toHaveLength(1);
});

it("keeps authoring unchanged after a failed acceptance transaction and replays the person's retry once", async () => {
  const { call, base } = await generated();
  const { jobs } = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const route = `${base}/drafting-jobs/${jobs[0].id}`;
  const claim = await call(`${route}/claim`, "POST", {
    revision: jobs[0].revision,
  });
  const laneOutput = reportLaneOutput(claim.contextBundle);
  const { job } = await call(`${route}/submit`, "POST", {
    leaseId: claim.job.lease.id,
    contextHash: claim.job.contextHash,
    result: { laneOutput },
  });
  const decision = { revision: job.revision, laneOutput };
  const { preview } = await call(`${route}/accept-preview`, "POST", decision);
  const before = await call(`${base}/package`);
  const body = {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "accept-retry",
  };
  service.failNextTransaction("40001");
  await call(`${route}/accept`, "POST", body, engineer, 503);
  expect((await call(`${base}/package`)).currentStateHash).toBe(
    before.currentStateHash,
  );
  const accepted = await call(`${route}/accept`, "POST", body);
  expect(accepted.job.decision.authoringRevision).toBe(2);
  expect(await call(`${route}/accept`, "POST", body)).toEqual(accepted);
});
