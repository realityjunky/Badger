import { expect, test } from "@playwright/test";

test("reviews a combined repair from either source draft and returns it with feedback", async ({
  page,
  request,
  baseURL,
}) => {
  const api = "/api/v1";
  const headers = { origin: new URL(baseURL!).origin };
  const groupResponse = await request.post(api + "/groups", {
    headers,
    data: { name: "Plan repairs " + Date.now() },
  });
  await expect(groupResponse).toBeOK();
  const { group } = await groupResponse.json();
  const workflowResponse = await request.post(api + "/workflows", {
    headers,
    data: {
      groupId: group.id,
      name: "plan-repair-" + Date.now(),
      goal: "Review both reports.",
      intent: "new-skill",
      locale: "en",
    },
  });
  await expect(workflowResponse).toBeOK();
  const { workflow, version } = await workflowResponse.json();
  const path = `/workflows/${workflow.id}/versions/${version.id}`;
  const plan = {
    workflow: { name: "Reports", customNodes: [] },
    goal: "Review both reports.",
  };
  const snapshot = { plan, dossierHash: "dossier" };
  const head = {
    id: "head",
    number: 2,
    hash: "plan",
    snapshot,
    canonicalJson: JSON.stringify(snapshot),
  };
  const sources = ["reference", "script"].map((lane) => ({
    id: lane,
    kind: "draft-plan",
    status: lane === "script" ? "accepted" : "cancelled",
    revision: 5,
    reconciliationHeadId: lane === "reference" ? head.id : undefined,
    authoringFollowUp: {
      lane,
      action: { requirement: "Review the " + lane + " report." },
    },
  }));
  const items = sources.map(({ id }) => ({
    id,
    source: id,
    description: "Check " + id + " evidence.",
  }));
  const repair = {
    id: "combined",
    kind: "draft-plan",
    status: "submitted",
    revision: 4,
    planRepair: {
      wave: "wave1",
      basePlanVersionId: head.id,
      sourceDraftIds: sources.map(({ id }) => id),
      items,
    },
    result: {
      plan,
      resolutions: {
        reference: {
          status: "addressed",
          explanation: "The earlier draft addressed this.",
        },
        script: { status: "addressed", explanation: "The script is pinned." },
      },
    },
    review: {
      result: {
        plan,
        resolutions: {
          reference: {
            status: "needs-evidence",
            explanation: "Supply the reference receipt.",
          },
          script: { status: "addressed", explanation: "The script is pinned." },
        },
      },
    },
  };
  // The current service creates wave repairs directly. Model a saved pair of lane drafts from an older release.
  let jobs: object[] = sources;
  await page.route("**" + api + path + "/plan", (route) =>
    route.fulfill({
      json: {
        versions: [head],
        currentVersionId: head.id,
        headVersionId: head.id,
        skeleton: plan,
        dossierHash: "dossier",
        confirmation: null,
      },
    }),
  );
  await page.route("**" + api + path + "/plan/preview", (route) =>
    route.fulfill({ json: { composition: { ...head, findings: [] } } }),
  );
  await page.route("**" + api + path + "/drafting-jobs", (route) =>
    route.fulfill({ json: { jobs } }),
  );
  await page.route(
    "**" + api + path + "/drafting-jobs/reference/request-plan-repair",
    (route) => {
      expect(route.request().postDataJSON()).toEqual({
        revision: 5,
        confirmed: true,
      });
      jobs = [...sources, repair];
      return route.fulfill({ json: { job: repair } });
    },
  );
  await page.route(
    "**" + api + path + "/drafting-jobs/combined/return-plan",
    (route) => {
      const body = route.request().postDataJSON();
      expect(body).toEqual({
        revision: 4,
        reason: "Attach the reference receipt.",
        confirmed: true,
      });
      const returned = {
        ...repair,
        status: "queued",
        revision: 5,
        feedback: { reason: body.reason },
      };
      jobs = [...sources, returned];
      return route.fulfill({ json: { job: returned } });
    },
  );

  await page.goto(path + "#plan");
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
  const panel = page.getByRole("tabpanel", {
    name: "Plan drafting jobs and suggestions",
  });
  const requestRepair = panel.getByRole("button", {
    name: "Request agent reconciliation",
  });
  await requestRepair.click();
  await expect(page).toHaveURL(/planDraft=combined#plan$/);
  await expect(
    panel.getByText("Findings from reference and script"),
  ).toBeVisible();
  await expect(panel.getByText("Needs evidence (1)")).toBeVisible();
  await expect(panel.getByText("Package finding from reference")).toBeHidden();
  await expect(panel.getByText("Earlier drafts (2)")).toBeVisible();
  await expect(requestRepair).toHaveCount(0);
  for (const { id } of sources) {
    await page.goto(path + "?planDraft=" + id + "#plan");
    const source = panel.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "Package finding from " + id }),
    });
    await source
      .getByRole("link", { name: "View the repair that includes this draft" })
      .click();
    await expect(page).toHaveURL(/planDraft=combined#plan$/);
  }
  await expect(
    panel.getByRole("button", { name: "Send back to agent" }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Review plan repair" }).click();
  const review = page.getByRole("dialog", { name: "Review plan repair" });
  await expect(
    review.getByText("Supply the reference receipt.", { exact: false }),
  ).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Preview plan version" }),
  ).toBeEnabled();
  await review.getByRole("button", { name: "Send back to agent" }).click();
  const feedback = page.getByRole("dialog", { name: "Send back to agent" });
  await expect(
    feedback.getByRole("button", { name: "Send back to agent" }),
  ).toBeDisabled();
  await feedback.getByRole("button", { name: "Cancel" }).click();
  await review.getByRole("button", { name: "Send back to agent" }).click();
  await feedback
    .getByLabel("Requested revisions")
    .fill("Attach the reference receipt.");
  await feedback.getByRole("button", { name: "Send back to agent" }).click();
  await expect(panel.getByText("Queued for revision")).toBeVisible();
  await expect(
    panel.getByText("Attach the reference receipt.", { exact: false }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Copy Agent prompt" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Review plan repair" }),
  ).toHaveCount(0);
});
