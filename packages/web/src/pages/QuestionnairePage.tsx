import { SearchOutlined } from "@ant-design/icons";
import { Input, Tabs } from "antd";
import { PageHeader } from "../components/PageHeader.js";
import { useI18n } from "../i18n/I18nContext.js";

/**
 * The registry's three panes: the explorer on the left, the record in the
 * middle, and a persistent inspector on the right.
 */
export function QuestionnairePage() {
  const { t } = useI18n();
  return (
    <div className="page page-registry" data-testid="page-questionnaire">
      <PageHeader
        title={t("page.questionnaire.title")}
        description={t("page.questionnaire.description")}
      />

      <div className="three-pane" data-testid="three-pane">
        <section
          className="pane explorer-pane"
          data-testid="explorer-pane"
          aria-label={t("questionnaire.explorer")}
        >
          <Input
            allowClear
            prefix={<SearchOutlined aria-hidden="true" />}
            placeholder={t("questionnaire.searchQuestions")}
            aria-label={t("questionnaire.searchQuestions")}
            data-testid="question-search"
          />
          <h2 className="pane-title">{t("questionnaire.rounds")}</h2>
          <p className="muted">{t("questionnaire.empty")}</p>
        </section>

        <section
          className="pane main-pane"
          data-testid="main-pane"
          aria-label={t("questionnaire.thread")}
        >
          <h2 className="pane-title">{t("questionnaire.thread")}</h2>
          <label className="field-label" htmlFor="answer-box">
            {t("questionnaire.answer")}
          </label>
          <textarea
            id="answer-box"
            className="answer-box"
            data-testid="answer-box"
            placeholder={t("questionnaire.answerPlaceholder")}
          />
          <p className="muted">{t("common.placeholderHint")}</p>
        </section>

        <aside
          className="pane inspector-pane"
          data-testid="inspector-pane"
          aria-label={t("questionnaire.inspector")}
        >
          <h2 className="pane-title">{t("questionnaire.inspector")}</h2>
          <Tabs
            className="underline-tabs"
            items={[
              {
                key: "evidence",
                label: t("questionnaire.evidence"),
                children: (
                  <p className="muted">{t("common.placeholderHint")}</p>
                ),
              },
              {
                key: "facts",
                label: t("questionnaire.facts"),
                children: (
                  <p className="muted">{t("common.placeholderHint")}</p>
                ),
              },
              {
                key: "history",
                label: t("questionnaire.history"),
                children: (
                  <p className="muted">{t("common.placeholderHint")}</p>
                ),
              },
            ]}
          />
        </aside>
      </div>
    </div>
  );
}
