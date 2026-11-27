import { expect, test } from "@playwright/test";

test("opens the blocked half of a submitted package writer and its findings", async ({
  page,
  request,
  baseURL,
}) => {
  const headers = { origin: new URL(baseURL!).origin };
  const group = await request.post("/api/v1/groups", {
    headers,
    data: { name: "Writer report " + Date.now() },
  });
  await expect(group).toBeOK();
  const created = await request.post("/api/v1/workflows", {
    headers,
    data: {
      groupId: (await group.json()).group.id,
      name: "writer-report-" + Date.now(),
      goal: "Prepare a reviewed report.",
      intent: "new-skill",
      locale: "en",
    },
  });
  await expect(created).toBeOK();
  const { workflow, version } = await created.json();
  const path = "/workflows/" + workflow.id + "/versions/" + version.id;
  const contract = { nodes: {}, outputSchemas: [] };
  await page.route("**/api/v1" + path, async (route) => {
    const detail = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...detail,
        jobs: [...detail.jobs, { kind: "generate", status: "succeeded" }],
      },
    });
  });
  await page.route("**/api/v1" + path + "/working-dossier", async (route) => {
    const dossier = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...dossier,
        available: true,
        revision: 1,
        content: { ...dossier.content, contract },
      },
    });
  });
  const lanes = [
    { id: "workflow-entry", dependencies: [] },
    { id: "skill-review", dependencies: ["workflow-entry"] },
  ];
  const finding = {
    severity: "important",
    problem: "Which reports may be recorded?",
    fix: "Ask the report owner.",
    disposition: {
      route: "question",
      subject: "Recording decision",
      target: "/topics/guardrails",
      authority: "Report owner",
      acceptance: "Define when recording is allowed.",
    },
  };
  const planFinding = {
    severity: "critical",
    problem: "The report has no verifier requirement.",
    disposition: {
      route: "plan",
      subject: "Report verification",
      target: "/nodes/report",
      authority: "Report owner",
      acceptance: "Identify the required verifier.",
      due: "run",
    },
  };
  await page.route("**/api/v1" + path + "/package", (route) =>
    route.fulfill({
      json: {
        canGenerate: true,
        jobs: [],
        package: {
          id: "candidate",
          status: "current",
          files: [],
          authoringPlan: {
            semanticDossier: { workingDossier: { content: { contract } } },
            lanes,
            dag: { wave2: ["workflow-entry"], barrier: ["skill-review"] },
          },
        },
      },
    }),
  );
  await page.route("**/api/v1" + path + "/package/authoring", (route) =>
    route.fulfill({
      json: {
        mapped: true,
        current: true,
        followUps: [],
        readiness: {
          recovery: {},
          lanes: Object.fromEntries(
            lanes.map((l) => [l.id, { ...l, status: "PENDING", blockers: [] }]),
          ),
          records: {},
          completedLanes: [],
          status: "in-progress",
        },
        jobs: [
          {
            id: "writer",
            laneId: "workflow-entry",
            kind: "authoring-lane",
            status: "submitted",
            revision: 4,
            staged: false,
            result: {
              laneOutput: {
                lane: "workflow-entry",
                status: "DONE",
                summary: "The entry Skill is ready.",
              },
              nodeGuidance: {
                lane: "skill-core",
                status: "BLOCKED",
                summary: "Recording needs a decision.",
                findings: [finding, planFinding],
              },
            },
          },
        ],
      },
    }),
  );
  const observation = {
    id: "observation",
    job_id: "writer",
    package_id: "candidate",
    ordinal: 0,
    lane: "skill-core",
    current: true,
    finding,
    finding_ids: ["recording"],
  };
  await page.route("**/api/v1" + path + "/package/findings", (route) =>
    route.fulfill({
      json: {
        hash: "findings",
        observations: [
          observation,
          {
            ...observation,
            ordinal: 1,
            id: "missing-verifier",
            finding: planFinding,
            finding_ids: ["verifier"],
          },
          {
            ...observation,
            id: "older",
            job_id: "other-writer",
            finding: { ...finding, problem: "Earlier report format." },
            finding_ids: ["older-finding"],
          },
        ],
        findings: [
          {
            id: "verifier",
            problem: planFinding.problem,
            reviewed: true,
            status: "open",
            disposition: planFinding.disposition,
          },
          {
            id: "recording",
            problem: "Recording decision",
            reviewed: false,
            status: "suggested",
            disposition: finding.disposition,
          },
          {
            id: "older-finding",
            problem: "Earlier format",
            reviewed: false,
            status: "suggested",
            disposition: finding.disposition,
          },
        ],
        work: [],
        questions: [],
        pins: [],
        laneTargets: [],
        existingRepairs: [],
      },
    }),
  );
  await page.goto(path + "#release");
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
  const writer = page.getByRole("row", { name: /Package writer/ });
  await expect(writer).toContainText("BLOCKED");
  await writer.getByRole("button", { name: "Review result" }).click();
  const report = page.getByRole("dialog");
  await expect(
    report.getByText("The entry Skill is ready.", { exact: true }),
  ).toBeVisible();
  await expect(
    report.getByText("Recording needs a decision.", { exact: true }),
  ).toBeVisible();
  await expect(
    report.getByText(finding.problem, { exact: true }),
  ).toBeVisible();
  await expect(
    report.getByText("Evidence due before the affected Run action"),
  ).toBeVisible();
  await expect(
    report.getByRole("button", { name: "Copy Agent prompt" }),
  ).toBeVisible();
  await expect(
    report.getByRole("button", { name: "Preview acceptance" }),
  ).toHaveCount(0);
  await report.getByRole("link", { name: "Open writer findings" }).click();
  const panel = page.getByRole("region", { name: "Findings", exact: true });
  await expect(
    panel.getByRole("checkbox", { name: /Which reports may be recorded/ }),
  ).toBeVisible();
  await expect(panel.getByText("Earlier format", { exact: true })).toHaveCount(
    0,
  );
  await panel
    .getByRole("checkbox", { name: /Which reports may be recorded/ })
    .check();
  await panel.getByRole("button", { name: "Review grouping" }).click();
  const grouping = page.getByRole("dialog", { name: "Review grouping" });
  await expect(
    grouping.getByText("Ask an expert", { exact: true }),
  ).toBeVisible();
  await grouping.getByRole("button", { name: "Cancel" }).click();
  await panel
    .getByRole("checkbox", { name: planFinding.problem, exact: true })
    .check();
  await expect(
    panel.getByRole("button", { name: "Dispatch ready work" }),
  ).toBeDisabled();
  await panel.getByRole("link", { name: "Open executable behavior" }).click();
  await expect(
    page.getByRole("textbox", { name: "Executable behavior" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "View the related package finding" })
    .click();
  await expect(
    page.getByRole("tab", { name: "Package findings", selected: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Earlier format", { exact: true }),
  ).toBeVisible();
});
