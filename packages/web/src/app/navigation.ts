import type { MessageId } from "../i18n/catalog.js";

export interface RouteDefinition {
  /** The URL pattern, as the router reads it. */
  pattern: string;
  title: MessageId;
}

/**
 * Every page has its own URL, so history, refresh, and links from
 * notifications all land on the same place.
 */
export const routes: readonly RouteDefinition[] = [
  { pattern: "/", title: "page.myWork.title" },
  { pattern: "/my-work", title: "page.myWork.title" },
  { pattern: "/workflows", title: "page.workflows.title" },
  { pattern: "/workflows/:workflowId", title: "page.workflows.title" },
  {
    pattern: "/workflows/:workflowId/versions/:versionId",
    title: "page.workflows.title",
  },
  { pattern: "/questionnaire", title: "page.questionnaire.title" },
  {
    pattern: "/questionnaire/questions/:questionId",
    title: "page.questionnaire.title",
  },
  { pattern: "/skills", title: "page.skills.title" },
  { pattern: "/skills/:skillId", title: "page.skills.title" },
  { pattern: "/runs", title: "page.runs.title" },
  { pattern: "/runs/:runId", title: "page.runs.title" },
  { pattern: "/evaluations", title: "page.evaluations.title" },
  { pattern: "/activity", title: "page.activity.title" },
  { pattern: "/admin", title: "page.admin.title" },
  { pattern: "/admin/members", title: "page.admin.title" },
  { pattern: "/admin/groups", title: "page.admin.title" },
  { pattern: "/admin/invitations", title: "page.admin.title" },
  { pattern: "/admin/integrations", title: "page.admin.title" },
  { pattern: "/admin/tokens", title: "page.admin.title" },
  { pattern: "/settings", title: "page.settings.title" },
  { pattern: "/settings/appearance", title: "page.settings.title" },
  { pattern: "/settings/language", title: "page.settings.title" },
  { pattern: "/settings/notifications", title: "page.settings.title" },
  { pattern: "/settings/tokens", title: "page.settings.title" },
  { pattern: "/settings/channels", title: "page.settings.title" },
  { pattern: "*", title: "page.notFound.title" },
];

export interface NavigationItem {
  path: string;
  title: MessageId;
  icon:
    | "work"
    | "workflows"
    | "questionnaire"
    | "skills"
    | "runs"
    | "evaluations"
    | "activity"
    | "admin"
    | "settings";
}

export interface NavigationSection {
  title: MessageId;
  items: readonly NavigationItem[];
}

/** The rail's grouped sections, My work first. */
export const navigationSections: readonly NavigationSection[] = [
  {
    title: "nav.section.work",
    items: [
      { path: "/my-work", title: "nav.myWork", icon: "work" },
      { path: "/workflows", title: "nav.workflows", icon: "workflows" },
      {
        path: "/questionnaire",
        title: "nav.questionnaire",
        icon: "questionnaire",
      },
      { path: "/skills", title: "nav.skills", icon: "skills" },
    ],
  },
  {
    title: "nav.section.operations",
    items: [
      { path: "/runs", title: "nav.runs", icon: "runs" },
      { path: "/evaluations", title: "nav.evaluations", icon: "evaluations" },
      { path: "/activity", title: "nav.activity", icon: "activity" },
    ],
  },
  {
    title: "nav.section.administration",
    items: [{ path: "/admin", title: "nav.admin", icon: "admin" }],
  },
  {
    title: "nav.section.system",
    items: [{ path: "/settings", title: "nav.settings", icon: "settings" }],
  },
];

const PAGE_PREFIXES: readonly (readonly [string, MessageId])[] = [
  ["/my-work", "page.myWork.title"],
  ["/workflows", "page.workflows.title"],
  ["/questionnaire", "page.questionnaire.title"],
  ["/skills", "page.skills.title"],
  ["/runs", "page.runs.title"],
  ["/evaluations", "page.evaluations.title"],
  ["/activity", "page.activity.title"],
  ["/admin", "page.admin.title"],
  ["/settings", "page.settings.title"],
];

/** The page a URL belongs to, for the document title and the top bar. */
export function pageTitleKey(pathname: string): MessageId {
  const normalized = pathname.replace(/\/+$/u, "") || "/";
  if (normalized === "/") {
    return "page.myWork.title";
  }
  for (const [prefix, title] of PAGE_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return title;
    }
  }
  return "page.notFound.title";
}
