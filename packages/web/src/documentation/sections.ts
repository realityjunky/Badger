import type { MessageId } from "../i18n/catalog.js";

const workflowSubsections = [
  {
    id: "sources",
    title: "stage.sources",
    actions: [
      "documentation.workflows.sources",
      "documentation.workflows.sources.confirm",
    ],
  },
  {
    id: "source-study",
    title: "stage.sourceStudy",
    actions: [
      "documentation.workflows.study",
      "documentation.workflows.study.suggestions",
      "documentation.workflows.study.complete",
    ],
  },
  {
    id: "source-study-diagram",
    title: "workingDossier.diagram",
    actions: [
      "documentation.workflows.study.diagram",
      "documentation.workflows.study.handoffs",
      "documentation.workflows.study.routes",
      "documentation.workflows.study.findings",
    ],
  },
  {
    id: "source-study-evidence",
    title: "documentation.workflows.study.evidence.title",
    actions: [
      "documentation.workflows.study.pins",
      "documentation.workflows.study.evidence",
    ],
  },
  {
    id: "questionnaire",
    title: "documentation.workflows.questionnaire.title",
    actions: [
      "documentation.workflows.questionnaire",
      "documentation.workflows.questionnaire.readiness",
    ],
  },
  {
    id: "dossier",
    title: "stage.dossier",
    actions: [
      "documentation.workflows.dossier",
      "documentation.workflows.dossier.approve",
    ],
  },
  {
    id: "plan-proposal",
    title: "plan.title",
    actions: [
      "documentation.workflows.plan",
      "documentation.workflows.plan.drafts",
      "documentation.workflows.plan.approve",
    ],
  },
  {
    id: "workflow-checks",
    title: "documentation.workflows.checks.title",
    actions: [
      "documentation.workflows.checks.approvals",
      "documentation.workflows.checks.verification",
      "documentation.workflows.checks.hook",
    ],
  },
  {
    id: "proposal-initialization",
    title: "proposal.title",
    actions: [
      "documentation.workflows.proposal.initialize",
      "documentation.workflows.proposal.replace",
    ],
  },
  {
    id: "package",
    title: "stage.package",
    actions: [
      "documentation.workflows.package",
      "documentation.workflows.package.files",
      "documentation.workflows.package.dispatch",
      "documentation.workflows.package.regenerate",
      "documentation.workflows.package.assemble",
    ],
  },
  {
    id: "authoring-findings",
    title: "documentation.workflows.findings.title",
    actions: [
      "documentation.workflows.findings.report",
      "documentation.workflows.findings.concerns",
      "documentation.workflows.findings.revise",
      "documentation.workflows.findings.followUp",
      "documentation.workflows.findings.badger",
    ],
  },
  {
    id: "evaluation",
    title: "stage.evaluation",
    actions: [
      "documentation.workflows.evaluation",
      "documentation.workflows.evaluation.report",
    ],
  },
  {
    id: "review-publication",
    title: "stage.reviewPublication",
    actions: [
      "documentation.workflows.publication",
      "documentation.workflows.publication.install",
    ],
  },
] as const;

const skillSubsections = [
  {
    id: "script-effect-review",
    title: "effects.title",
    actions: [
      "documentation.skills.effects.source",
      "documentation.skills.effects.route",
      "documentation.skills.effects.roles",
      "documentation.skills.effects.answer",
      "documentation.skills.effects.confirm",
      "documentation.skills.effects.correct",
    ],
  },
  {
    id: "request-clarification",
    title: "effects.clarify",
    actions: [
      "documentation.skills.clarify.request",
      "documentation.skills.clarify.save",
      "documentation.skills.clarify.find",
      "documentation.skills.clarify.investigate",
      "documentation.skills.clarify.correction",
    ],
  },
] as const;

export const documentationSections = [
  {
    id: "my-work",
    title: "nav.myWork",
    actions: ["documentation.my-work.inbox", "documentation.my-work.scope"],
  },
  {
    id: "wecom-cli",
    title: "documentation.wecom-cli.title",
    ordered: true,
    actions: [
      "documentation.wecom-cli.step.prepare",
      "documentation.wecom-cli.step.robot",
      "documentation.wecom-cli.step.install",
      "documentation.wecom-cli.step.skills",
      "documentation.wecom-cli.step.authorize",
      "documentation.wecom-cli.step.verify",
      "documentation.wecom-cli.step.agent",
    ],
    resources: [
      {
        label: "documentation.wecom-cli.official",
        href: "https://open.work.weixin.qq.com/help2/pc/21676",
      },
      {
        label: "documentation.wecom-cli.overview",
        href: "https://open.work.weixin.qq.com/help2/pc/21705",
      },
      {
        label: "documentation.nodeDownload",
        href: "https://nodejs.org/en/download",
      },
    ],
  },
  {
    id: "mcp",
    title: "documentation.mcp.title",
    ordered: true,
    actions: [
      "documentation.mcp.step.prepare",
      "documentation.mcp.step.install",
      "documentation.mcp.step.token",
      "documentation.mcp.step.posix",
      "documentation.mcp.step.windows",
      "documentation.mcp.step.configure",
      "documentation.mcp.step.workbuddy",
      "documentation.mcp.step.cli",
      "documentation.mcp.step.verify",
    ],
    resources: [
      { label: "mcp.title", href: "/settings/tokens" },
      {
        label: "documentation.mcp.workbuddyDocs",
        href: "https://www.codebuddy.cn/docs/cli/mcp",
      },
      {
        label: "documentation.mcp.claudeDocs",
        href: "https://code.claude.com/docs/en/mcp",
      },
      {
        label: "documentation.mcp.codexDocs",
        href: "https://developers.openai.com/codex/mcp",
      },
    ],
  },
  {
    id: "workflows",
    title: "nav.workflows",
    actions: [],
    subsections: workflowSubsections,
  },
  {
    id: "questionnaire",
    title: "nav.questionnaire",
    actions: [
      "documentation.questionnaire.answer",
      "documentation.questionnaire.resolve",
      "documentation.questionnaire.ledger",
      "documentation.questionnaire.drafting.scenario",
      "documentation.questionnaire.drafting.work",
      "documentation.questionnaire.drafting.review",
    ],
  },
  {
    id: "skills",
    title: "nav.skills",
    actions: [
      "documentation.skills.add",
      "documentation.skills.upload",
      "documentation.skills.git",
      "documentation.skills.inventory",
      "documentation.skills.confirm",
    ],
    subsections: skillSubsections,
  },
  {
    id: "runs",
    title: "nav.runs",
    actions: ["documentation.runs.gates", "documentation.runs.recovery"],
  },
  {
    id: "evaluations",
    title: "nav.evaluations",
    actions: [
      "documentation.evaluations.start",
      "documentation.evaluations.report",
    ],
  },
  {
    id: "activity",
    title: "nav.activity",
    actions: ["documentation.activity.filter", "documentation.activity.reason"],
  },
  {
    id: "admin",
    title: "documentation.administration",
    actions: [
      "documentation.admin.members",
      "documentation.admin.invitations",
      "documentation.admin.integrations",
    ],
  },
  {
    id: "settings",
    title: "nav.settings",
    actions: [
      "documentation.settings.preferences",
      "documentation.settings.tokens",
      "documentation.settings.chatModes",
      "documentation.settings.notifications",
      "documentation.settings.channels",
    ],
    subsections: [
      {
        id: "robots",
        title: "robots.title",
        purpose: "documentation.settings.robots.purpose",
        next: "documentation.settings.robots.next",
        actions: [
          "documentation.settings.robots.step.wecom",
          "documentation.settings.robots.step.userid",
          "documentation.settings.robots.step.register",
          "documentation.settings.robots.step.verify",
          "documentation.settings.robots.step.route",
          "documentation.settings.robots.step.test",
        ],
      },
    ],
  },
] as const satisfies readonly {
  id: string;
  title: MessageId;
  actions: readonly MessageId[];
  ordered?: boolean;
  resources?: readonly { label: MessageId; href: string }[];
  subsections?: readonly {
    id: string;
    title: MessageId;
    purpose?: MessageId;
    next?: MessageId;
    actions: readonly MessageId[];
  }[];
}[];

export const documentationCommands: Partial<Record<MessageId, string>> = {
  "documentation.wecom-cli.step.prepare":
    "node --version\nnpm --version\nnpx --version",
  "documentation.wecom-cli.step.install":
    "npm install -g @wecom/cli\nwecom-cli --version",
  "documentation.wecom-cli.step.skills":
    "npx skills add WeComTeam/wecom-cli -y -g",
  "documentation.wecom-cli.step.authorize": "wecom-cli auth init",
  "documentation.wecom-cli.step.verify": "wecom-cli auth show --status",
  "documentation.wecom-cli.step.agent":
    "npx skills add WecomTeam/wecom-unified -y -g",
  "documentation.mcp.step.prepare": "node --version\nnpm --version",
  "documentation.mcp.step.install":
    "npm ci\nnpm run build\nnpm link -w packages/mcp",
  "documentation.mcp.step.posix":
    "read -r -s BADGER_TOKEN\nexport BADGER_TOKEN",
  "documentation.mcp.step.windows":
    "$badgerToken = Read-Host 'Badger token' -AsSecureString\n$env:BADGER_TOKEN = [System.Net.NetworkCredential]::new('', $badgerToken).Password\nRemove-Variable badgerToken",
};

export type DocumentationSection = (typeof documentationSections)[number]["id"];
export type DocumentationTopic =
  | DocumentationSection
  | `workflows/${(typeof workflowSubsections)[number]["id"]}`
  | `skills/${(typeof skillSubsections)[number]["id"]}`
  | "settings/robots"
  | "script-side-effects";

export function documentationSubsections(section: DocumentationSection) {
  const entry = documentationSections.find(({ id }) => id === section);
  return entry !== undefined && "subsections" in entry ? entry.subsections : [];
}

export function documentationSubsectionTopic(
  section: DocumentationSection,
  subsection: string,
): DocumentationTopic {
  return `${section}/${subsection}` as DocumentationTopic;
}

export function currentDocumentationSection(
  pathname: string,
): DocumentationSection {
  return (
    documentationSections.find(
      ({ id }) => pathname === `/${id}` || pathname.startsWith(`/${id}/`),
    )?.id ?? "my-work"
  );
}

/** Keep the page, scope, filters, and anchor while sharing or dismissing help. */
export function documentationSearch(
  search: string,
  topic: DocumentationTopic | null,
): string {
  const parameters = new URLSearchParams(search);
  if (topic === null) parameters.delete("help");
  else parameters.set("help", topic);
  const result = parameters.toString();
  return result === "" ? "" : `?${result}`;
}
