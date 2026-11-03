import { Button, Modal } from "antd";
import { useEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useDemoMode } from "../app/DemoContext.js";
import { useI18n } from "../i18n/I18nContext.js";
import { documentationSearch, documentationSections } from "./sections.js";

const effects = [
  "none",
  "local-writes",
  "network",
  "scheduler-submission",
  "installs",
] as const;

/** A URL-linked overlay: the current route and its in-progress forms stay mounted. */
export function DocumentationDialog() {
  const { t } = useI18n();
  const demoMode = useDemoMode();
  const location = useLocation();
  const navigate = useNavigate();
  const topic = new URLSearchParams(location.search).get("help");
  const section = documentationSections.find(
    ({ id }) =>
      id === topic || (id === "skills" && topic === "script-side-effects"),
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const effectsHeading = useRef<HTMLHeadingElement>(null);

  function focusTopic() {
    const target =
      topic === "script-side-effects"
        ? effectsHeading.current
        : heading.current;
    target?.scrollIntoView({ block: "start", behavior: "instant" });
    target?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (section) focusTopic();
  }, [topic]);

  function close() {
    void navigate(
      { ...location, search: documentationSearch(location.search, null) },
      { replace: true },
    );
  }

  return (
    <Modal
      open={section !== undefined}
      title={t("documentation.title")}
      onCancel={close}
      afterOpenChange={(open) => {
        if (open) focusTopic();
      }}
      closable={{ "aria-label": t("documentation.close") }}
      footer={<Button onClick={close}>{t("documentation.return")}</Button>}
      width={1040}
      className="documentation-dialog"
      zIndex={1200}
    >
      {section && (
        <div className="documentation-layout">
          <nav
            className="documentation-nav"
            aria-label={t("documentation.sections")}
          >
            {documentationSections.map((entry) => (
              <Link
                key={entry.id}
                to={{
                  ...location,
                  search: documentationSearch(location.search, entry.id),
                }}
                replace
                aria-current={entry.id === section.id ? "page" : undefined}
              >
                {t(entry.title)}
              </Link>
            ))}
          </nav>
          <article
            className="documentation-article"
            aria-labelledby="documentation-section-title"
          >
            <h2 ref={heading} id="documentation-section-title" tabIndex={-1}>
              {t(section.title)}
            </h2>
            <p>{t(`documentation.${section.id}.purpose`)}</p>
            <h3>{t("documentation.roles")}</h3>
            <p>{t(`documentation.${section.id}.roles`)}</p>
            <h3>{t("documentation.actions")}</h3>
            <ul className="documentation-actions">
              {section.actions.map((action) => (
                <li key={action}>{t(action)}</li>
              ))}
            </ul>
            {section.id === "skills" && (
              <section aria-labelledby="documentation-effects-title">
                <h3
                  ref={effectsHeading}
                  id="documentation-effects-title"
                  tabIndex={-1}
                >
                  {t("skills.effects")}
                </h3>
                <p>{t("documentation.effects.intro")}</p>
                <p>{t("documentation.effects.combine")}</p>
                <dl className="documentation-effects">
                  {effects.map((effect) => (
                    <div key={effect}>
                      <dt>
                        <strong>{t(`skills.effect.${effect}`)}</strong>{" "}
                        <code>{effect}</code>
                      </dt>
                      <dd>{t(`documentation.effects.${effect}`)}</dd>
                    </div>
                  ))}
                </dl>
                <p>{t("documentation.effects.noScripts")}</p>
              </section>
            )}
            <h3>{t("documentation.next")}</h3>
            <p>{t(`documentation.${section.id}.next`)}</p>
            <aside className="documentation-note">
              <p>{t("documentation.signOff")}</p>
              <p>{t("documentation.intro")}</p>
              {demoMode && <p>{t("documentation.demo")}</p>}
            </aside>
          </article>
        </div>
      )}
    </Modal>
  );
}
