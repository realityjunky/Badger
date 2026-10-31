import { createHash } from "node:crypto";
import { createQuestionnaireHandoff } from "@realityjunky/badger";
import type {
  WorkflowPendingAction,
  WorkflowStateProjection,
  WorkflowContinuation,
} from "@realityjunky/badger/workflow-runtime";

// Illustrative read models only: no service, database, filesystem, or identity
// dependencies. All IDs are confined to this fixture graph.
const at = "2026-10-01T09:00:00.000Z";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const packageHash = hash("demo sample-review package");
const content = `---
name: sample-review
description: Review a synthetic example and record the evidence.
---

# Sample review

Use synthetic examples only. A person reviews the findings before release.
`;
const file = {
  path: "SKILL.md",
  bytes: Buffer.byteLength(content),
  hash: hash(content),
};
const skillHash = hash("demo sample-review Skill version");
const workflow = {
  id: "demo-workflow",
  groupId: "demo-group",
  name: "Sample review",
  goal: "Review a synthetic example with evidence and a human decision before release.",
  intent: "new-skill",
  locale: "en",
  revision: 1,
};
const capabilities = {
  read: true,
  editWorkflow: false,
  manageRoles: false,
  createVersion: false,
  managePins: false,
  confirmSources: false,
  manageSourceStudy: false,
  composeDossier: false,
  approveDossier: false,
  editPlan: false,
  approvePlan: false,
  approveProposal: false,
  initialize: false,
  generate: false,
};
const stages = [
  "sources",
  "source-study",
  "questionnaire",
  "dossier",
  "plan-proposal",
  "package",
  "evaluation",
  "review-publication",
];
const version = {
  ...workflow,
  id: "demo-version",
  number: 1,
  stages: stages.map((id) => ({ id, state: "done" })),
};
const draftVersion = {
  ...version,
  id: "demo-draft-version",
  number: 2,
  inheritedFromVersionId: version.id,
  stages: stages.map((id, i) => ({
    id,
    state: i < 2 ? "done" : i === 2 ? "active" : "todo",
  })),
};
const versions = [draftVersion, version];
const bindings = [
  {
    role: "Workflow owner",
    displayName: "Morgan Lee",
    email: "morgan@example.com",
  },
  { role: "Engineer", displayName: "Alex Chen", email: "alex@example.com" },
  { role: "Field expert", displayName: "Sam Rivera", email: "sam@example.com" },
  { role: "Operator", displayName: "Taylor Kim", email: "taylor@example.com" },
].map((person, i) => ({
  ...person,
  id: `demo-binding-${i}`,
  pending: false,
  revision: 1,
}));
const pin = {
  workflowVersionId: draftVersion.id,
  skillId: "demo-skill",
  skillName: "Sample review Skill",
  hash: skillHash,
  purpose: "source",
  revision: 1,
  pinnedBy: "demo-engineer",
  createdAt: at,
  updatedAt: at,
};
const questionContent = {
  text: "What evidence must a person review before releasing the result?",
  topic: "completionEvidence",
  targets: [{ kind: "workflow", id: workflow.id }],
  rationale: "The release decision must refer to recorded evidence.",
  evidence: [
    {
      skillId: "demo-skill",
      versionHash: skillHash,
      path: file.path,
      startLine: 8,
      endLine: 8,
    },
  ],
  assignees: [{ kind: "role", role: "Field expert" }],
  priority: 1,
  answerType: { kind: "free-text" },
};
const question = {
  ...questionContent,
  id: "demo-question",
  roundId: "demo-round",
  revision: 1,
  state: "answered",
  parentQuestionId: null,
  resolutionRevision: 0,
  resolvedAt: null,
  canAnswer: false,
  revisions: [
    {
      ...questionContent,
      revision: 1,
      actorId: "demo-engineer",
      createdAt: at,
    },
  ],
};
const answerRevision = {
  revision: 1,
  questionRevision: 1,
  text: "Review the synthetic input, the findings, and the validation summary before release.",
  value:
    "Review the synthetic input, the findings, and the validation summary before release.",
  attachments: [],
  state: "submitted",
  channel: "web",
  agentHost: null,
  createdAt: at,
};
const questionnaire = {
  personId: "demo-viewer",
  workflow: { id: workflow.id, name: workflow.name },
  version: { id: draftVersion.id, number: 2, locale: "en" },
  capabilities: {
    compose: false,
    resolve: false,
    acknowledge: false,
    comment: false,
    raiseConcern: false,
    resolveConcern: false,
  },
  attachmentLimits: {
    maxFileBytes: 5_242_880,
    maxAnswerBytes: 20_971_520,
    maxFiles: 10,
    mediaTypes: [],
  },
  settings: { revision: 1, roundSizeLimit: null },
  assignees: [],
  pins: [{ skillId: pin.skillId, skillName: pin.skillName, hash: skillHash }],
  rounds: [
    {
      id: "demo-round",
      title: "Release evidence",
      number: 1,
      revision: 1,
      state: "published",
    },
  ],
  questions: [question],
  answers: [
    {
      ...answerRevision,
      questionId: question.id,
      personId: "demo-expert",
      personName: "Sam Rivera",
      eligibleForResolution: false,
      revisions: [answerRevision],
    },
  ],
  resolutions: [],
  facts: [],
  concerns: [],
  comments: [
    {
      id: "demo-comment",
      questionId: question.id,
      personId: "demo-engineer",
      personName: "Alex Chen",
      revision: 1,
      text: "Keep the review evidence with the result so the decision can be checked later.",
      actorId: "demo-engineer",
      createdAt: at,
      revisions: [],
    },
  ],
};
const pendingAction: WorkflowPendingAction = {
  id: "demo-action",
  stepId: "release",
  type: "ask_user",
  question: "Release this synthetic review result?",
  choices: [
    { id: "release", label: "Release after review" },
    { id: "revise", label: "Request another review" },
  ],
};
const projection: WorkflowStateProjection = {
  schemaVersion: 1,
  workflow: "sample-review",
  statePath: "example/.badger/runs/sample-review-001/state.json",
  status: "waiting",
  runId: "sample-review-001",
  revision: 1,
  currentNode: "release",
  cycleId: null,
  attemptId: "demo-attempt",
  visitOrdinal: 1,
  retryOrdinal: 0,
  completedNodes: ["review"],
  evidence: {},
  history: [],
  pendingAction,
  receiptOutputs: [],
  artifactReceipts: [],
  execution: {
    protocolHash: hash("demo protocol"),
    packageHash,
    snapshotHash: hash("demo snapshot"),
    nodeToStep: { review: "review", release: "release" },
  },
  visits: [],
  cycles: [],
  decisionReceipts: [],
  verificationReceipts: [],
  artifactVersions: [],
  artifactSelections: [],
  currentArtifactVersions: {},
  contentSnapshots: [],
  blockers: [],
  findings: [],
  findingSummary: {
    catalogVersion: 1,
    total: 0,
    returned: 0,
    omitted: 0,
    omittedBySeverity: { info: 0, warning: 0, error: 0 },
    omittedByCode: {},
    omittedRequiresUserDecision: 0,
    truncated: false,
    encodedBytes: 0,
    maxEncodedBytes: 16384,
  },
  requiresUserDecision: true,
};
const continuation: WorkflowContinuation = {
  ...projection,
  disposition: "await-user",
  completion: null,
};
const run = {
  id: "demo-run",
  workflowId: workflow.id,
  publicationId: "demo-publication",
  packageHash,
  personId: "demo-operator",
  personName: "Taylor Kim",
  localRunId: "sample-review-001",
  hostLabel: "Example laptop",
  agentHost: "Example Agent",
  testRun: true,
  createdAt: at,
  updatedAt: at,
  lastSequence: 0,
  projection,
  continuation,
  events: [],
};
const evaluation = {
  id: "demo-evaluation",
  jobId: "demo-evaluation-job",
  packageId: "demo-package",
  packageHash,
  starterId: "demo-engineer",
  starterName: "Alex Chen",
  startedAt: at,
  finishedAt: "2026-10-01T09:00:02.000Z",
  durationMilliseconds: 2000,
  report: {
    schemaVersion: 1,
    hash: hash("demo evaluation report"),
    passed: true,
    checks: [
      {
        id: "package-integrity",
        passed: true,
        detail: "The sample package matches its reviewed content.",
      },
      {
        id: "authoring-evidence",
        passed: true,
        detail:
          "The sample's authoring evidence covers the declared responsibilities.",
      },
      {
        id: "workflow-runtime-certification",
        passed: true,
        detail:
          "Illustrative result: the synthetic review completes after a human decision.",
      },
    ],
  },
};
const activity = {
  id: "demo-activity",
  occurredAt: at,
  actorPersonId: "demo-owner",
  actorDisplayName: "Morgan Lee",
  actorEmail: "morgan@example.com",
  channel: "web",
  action: "publication.published",
  targetType: "workflow",
  targetId: workflow.id,
  targetLabel: workflow.name,
  reason: "Publish the reviewed synthetic example for onboarding.",
};
const inboxItem = {
  workflowVersionId: draftVersion.id,
  workflowName: workflow.name,
  versionNumber: 2,
  gate: "questionnaire",
  kind: "answer-submitted",
  questionId: question.id,
  questionText: question.text,
  concernId: null,
  concernText: null,
  state: "unread",
  revision: 1,
  createdAt: at,
};
const base = `/workflows/${workflow.id}/versions/`;
const workflowDetail = {
  workflow,
  groupName: "Example team",
  versions,
  bindings,
  capabilities,
};
const handoff = createQuestionnaireHandoff({
  records: {
    questions: [
      {
        id: question.id,
        revision: 1,
        topic: "completionEvidence",
        text: question.text,
        state: "answered",
      },
    ],
    pins: [{ ...pin, studied: true }],
  },
});
const versionDetail = (selected: typeof version) => ({
  workflow,
  version: selected,
  capabilities,
  pins: [{ ...pin, workflowVersionId: selected.id }],
  sourceCheck: null,
  jobs: [],
  sourceGate: null,
  sourceStudy: {
    facts: [],
    interfaces: [],
    studies: [
      {
        ...pin,
        workflowVersionId: selected.id,
        studied: true,
        confirmation: null,
      },
    ],
  },
});

/** Explicit fixture routes; an unknown ID can never fall through to live data. */
export function demoResponse(path: string, query: URLSearchParams): unknown {
  const records: Record<string, unknown> = {
    "/me": {
      person: {
        id: "demo-viewer",
        displayName: "Demo visitor",
        email: "demo@example.com",
        roles: ["Auditor"],
        groups: [],
      },
      signOut: false,
    },
    "/me/preferences": {
      preferences: {
        language: "en",
        theme: "system",
        fontScale: 100,
        railCollapsed: false,
        revision: 0,
        updatedAt: null,
      },
    },
    "/me/inbox": {
      items: [
        {
          ...inboxItem,
          id: "demo-inbox-question",
          href: `/questionnaire/questions/${question.id}`,
        },
        {
          ...inboxItem,
          id: "demo-inbox-gate",
          kind: "gate-ready",
          gate: "run:demo-run-gate",
          questionId: null,
          questionText: null,
          workflowVersionId: version.id,
          versionNumber: 1,
          href: `/runs/${run.id}`,
        },
      ],
      unreadCount: 2,
      pendingCount: 2,
      pendingQuestionCount: 1,
      pendingGateCount: 1,
      nextCursor: null,
    },
    "/workflows": {
      workflows: [
        {
          ...workflow,
          groupName: "Example team",
          latestVersion: draftVersion,
          capabilities,
        },
      ],
      createGroups: [],
    },
    [`/workflows/${workflow.id}`]: workflowDetail,
    "/questionnaire": {
      versions: [
        {
          workflowId: workflow.id,
          workflowName: workflow.name,
          versionId: draftVersion.id,
          number: 2,
        },
      ],
    },
    [`/questionnaire/questions/${question.id}`]: {
      workflowId: workflow.id,
      versionId: draftVersion.id,
    },
    [`${base}${draftVersion.id}/questionnaire`]: questionnaire,
    "/skills": {
      skills: [
        {
          id: pin.skillId,
          groupId: workflow.groupId,
          name: pin.skillName,
          canUpload: false,
        },
      ],
      groups: [
        {
          id: workflow.groupId,
          name: "Example team",
          canUpload: false,
          canCreateSkill: false,
        },
      ],
      limits: { maxBytes: 20_971_520, maxFileBytes: 5_242_880, maxFiles: 1000 },
    },
    [`/skills/${pin.skillId}/versions`]: {
      versions: [
        {
          skillId: pin.skillId,
          hash: skillHash,
          description: "A synthetic review Skill for exploring Badger.",
          inventory: [file],
          scripts: [],
          uploadedBy: "demo-expert",
          createdAt: at,
          origin: "upload",
          gitOrigins: [],
        },
      ],
    },
    [`/skills/${pin.skillId}/backlog`]: { items: [] },
    "/me/runs": { runs: [run] },
    [`/workflows/${workflow.id}/runs`]: { runs: [run] },
    [`/runs/${run.id}`]: { run },
    [`/runs/${run.id}/gates`]: {
      gates: [
        {
          id: "demo-run-gate",
          state: "open",
          revision: 1,
          pendingAction,
          finalizationPreview: null,
          canAnswer: false,
          answer: null,
        },
      ],
    },
    [`${base}${version.id}/evaluations`]: {
      canEvaluate: false,
      currentPackageHash: packageHash,
      passingReportId: evaluation.id,
      readiness: null,
      reports: [evaluation],
      jobs: [],
    },
    [`${base}${draftVersion.id}/evaluations`]: {
      canEvaluate: false,
      currentPackageHash: null,
      passingReportId: null,
      readiness: null,
      reports: [],
      jobs: [],
    },
    [`/workflows/${workflow.id}/notifications/waiting`]: { items: [] },
  };
  if (path === `/skills/${pin.skillId}/versions/${skillHash}/files`) {
    return query.get("path") === file.path
      ? { ...file, content, binary: false, tooLarge: false }
      : undefined;
  }
  if (path === "/audit-events") {
    const matches = ["actorEmail", "action", "targetType", "channel"].every(
      (key) =>
        !query.has(key) ||
        query.get(key) === activity[key as keyof typeof activity],
    );
    const from = query.get("from");
    const to = query.get("to");
    return {
      events:
        matches && (!from || from <= at) && (!to || to >= at) ? [activity] : [],
      nextCursor: null,
    };
  }
  for (const selected of versions) {
    const prefix = `${base}${selected.id}`;
    if (path === prefix) return versionDetail(selected);
    if (path === `${prefix}/dossier`)
      return {
        versions: [],
        headVersionId: null,
        currentVersionId: null,
        confirmation: null,
        handoff,
      };
    if (path === `${prefix}/plan`)
      return {
        versions: [],
        dossierHash: null,
        skeleton: null,
        headVersionId: null,
        currentVersionId: null,
        confirmation: null,
      };
    if (path === `${prefix}/proposal`)
      return {
        proposal: null,
        planVersionHash: null,
        confirmation: null,
        currentState: null,
        jobs: [],
      };
    if (path === `${prefix}/package`)
      return {
        canGenerate: false,
        currentStateHash: null,
        package: null,
        jobs: [],
      };
    if (path === `${prefix}/review`)
      return {
        currentPackageHash: null,
        passingReportId: null,
        approvalId: null,
        readiness: null,
        canReview: false,
        canPublish: false,
        canOverride: false,
        requiresOverride: false,
        reviews: [],
        publications: [],
      };
    if (path === `${prefix}/questionnaire/ledger`)
      return {
        handoff,
        baselines: [{ id: "demo-round", title: "Release evidence", number: 1 }],
        sinceRound: query.get("sinceRound"),
        changes: null,
      };
  }
  return Object.hasOwn(records, path) ? records[path] : undefined;
}
