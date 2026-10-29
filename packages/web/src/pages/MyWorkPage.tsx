import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader.js";
import { useI18n } from "../i18n/I18nContext.js";
import type { MessageId } from "../i18n/catalog.js";
import { useInbox } from "../inbox/InboxContext.js";
import { InboxPanel } from "../inbox/InboxPanel.js";

interface Metric {
  label: MessageId;
  path: string;
  testId: string;
}

const METRICS: readonly Metric[] = [
  {
    label: "myWork.metrics.waitingQuestions",
    path: "/questionnaire",
    testId: "metric-questions",
  },
  {
    label: "myWork.metrics.gates",
    path: "/my-work#inbox",
    testId: "metric-gates",
  },
  {
    label: "myWork.metrics.drafts",
    path: "/runs",
    testId: "metric-drafts",
  },
  {
    label: "myWork.metrics.inbox",
    path: "/my-work#inbox",
    testId: "metric-inbox",
  },
];

/** The landing page: what waits for this person across their workflows. */
export function MyWorkPage() {
  const { t } = useI18n();
  const { page } = useInbox();
  return (
    <div className="page" data-testid="page-my-work">
      <PageHeader
        title={t("page.myWork.title")}
        description={t("page.myWork.description")}
      />
      <section
        className="summary-strip"
        aria-label={t("page.myWork.title")}
        data-testid="summary-strip"
      >
        {METRICS.map((metric) => (
          <Link
            className="summary-card"
            to={metric.path}
            key={metric.label}
            data-testid={metric.testId}
          >
            <span className="summary-value">
              {metric.testId === "metric-inbox"
                ? page.unreadCount
                : metric.testId === "metric-gates"
                  ? page.pendingGateCount
                  : metric.testId === "metric-questions"
                    ? page.pendingQuestionCount
                    : 0}
            </span>
            <span className="summary-label">{t(metric.label)}</span>
          </Link>
        ))}
      </section>
      <InboxPanel />
      {page.pendingCount === 0 && (
        <p className="empty-state" data-testid="my-work-empty">
          {t("page.myWork.empty")}
        </p>
      )}
    </div>
  );
}
