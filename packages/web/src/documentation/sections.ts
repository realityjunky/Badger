import type { MessageId } from "../i18n/catalog.js";

export const documentationSections = [
  {
    id: "my-work",
    title: "nav.myWork",
    actions: ["documentation.my-work.inbox", "documentation.my-work.scope"],
  },
  {
    id: "workflows",
    title: "nav.workflows",
    actions: [
      "documentation.workflows.sources",
      "documentation.workflows.study",
      "documentation.workflows.questionnaire",
      "documentation.workflows.dossier",
      "documentation.workflows.plan",
      "documentation.workflows.package",
      "documentation.workflows.evaluation",
      "documentation.workflows.publication",
    ],
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
      "documentation.settings.notifications",
    ],
  },
] as const satisfies readonly {
  id: string;
  title: MessageId;
  actions: readonly MessageId[];
}[];

export type DocumentationSection = (typeof documentationSections)[number]["id"];
export type DocumentationTopic = DocumentationSection | "script-side-effects";

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
