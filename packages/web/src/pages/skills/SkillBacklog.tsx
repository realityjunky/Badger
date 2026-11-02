import { Alert, Button } from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { questionnaireRequest } from "../../api/questionnaire.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useLiveUpdates } from "../../live/LiveUpdatesContext.js";

interface BacklogItem {
  questionId: string;
  text: string;
  reason: string;
  workflowName: string;
  href: string;
}
export function SkillBacklog({ skillId }: { skillId: string }) {
  const { t } = useI18n();
  const { notice } = useLiveUpdates();
  const [items, setItems] = useState<BacklogItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setItems(null);
  }, [skillId]);
  useEffect(() => {
    const controller = new AbortController();
    void questionnaireRequest<{ items: BacklogItem[] }>(
      readBasePath(document),
      `/skills/${encodeURIComponent(skillId)}/backlog`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setItems(value.items);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [skillId, notice, retry]);
  return (
    <section className="questionnaire-record" aria-label={t("skills.backlog")}>
      <h3>{t("skills.backlog")}</h3>
      {failed ? (
        <Alert
          type="error"
          message={t("skills.failed")}
          action={
            <Button onClick={() => setRetry(retry + 1)}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : items === null ? (
        <p role="status">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p className="muted">{t("skills.backlogEmpty")}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.questionId}>
              <Link to={item.href}>{item.text}</Link>
              <p>{item.reason}</p>
              <p className="muted">{item.workflowName}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
