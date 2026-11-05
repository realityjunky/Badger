import { Button, Modal } from "antd";
import { useEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { NOTIFICATION_EVENTS } from "../api/notifications.js";
import { useDemoMode } from "../app/DemoContext.js";
import { useI18n } from "../i18n/I18nContext.js";
import {
  documentationSearch,
  documentationSections,
  documentationSubsectionTopic,
  documentationSubsections,
} from "./sections.js";

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
  const topicSection = topic?.split("/", 1)[0];
  const section = documentationSections.find(
    ({ id }) =>
      id === topicSection ||
      (id === "skills" && topic === "script-side-effects"),
  );
  const subsection =
    section === undefined || topic === "script-side-effects"
      ? undefined
      : documentationSubsections(section.id).find(
          ({ id }) => topic === documentationSubsectionTopic(section.id, id),
        );
  const heading = useRef<HTMLHeadingElement>(null);
  const subsectionHeading = useRef<HTMLHeadingElement>(null);
  const effectsHeading = useRef<HTMLHeadingElement>(null);

  function focusTopic() {
    const target =
      topic === "script-side-effects"
        ? effectsHeading.current
        : subsection !== undefined
          ? subsectionHeading.current
          : heading.current;
    target?.scrollIntoView({ block: "start", behavior: "instant" });
    target?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (section) focusTopic();
  }, [subsection, topic]);

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
              <div className="documentation-nav-group" key={entry.id}>
                <Link
                  to={{
                    ...location,
                    search: documentationSearch(location.search, entry.id),
                  }}
                  replace
                  aria-current={topic === entry.id ? "page" : undefined}
                >
                  {t(entry.title)}
                </Link>
                {documentationSubsections(entry.id).map((child) => {
                  const childTopic = documentationSubsectionTopic(
                    entry.id,
                    child.id,
                  );
                  return (
                    <Link
                      className="documentation-nav-subsection"
                      key={childTopic}
                      to={{
                        ...location,
                        search: documentationSearch(
                          location.search,
                          childTopic,
                        ),
                      }}
                      replace
                      aria-current={topic === childTopic ? "page" : undefined}
                    >
                      {t(child.title)}
                    </Link>
                  );
                })}
              </div>
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
            {subsection !== undefined && (
              <section
                aria-labelledby="documentation-subsection-title"
                className="documentation-subsection"
              >
                <h3
                  ref={subsectionHeading}
                  id="documentation-subsection-title"
                  tabIndex={-1}
                >
                  {t(subsection.title)}
                </h3>
                <p>{t(subsection.purpose)}</p>
                <h4>{t("documentation.steps")}</h4>
                <ol className="documentation-actions">
                  {subsection.actions.map((action) => (
                    <li key={action}>{t(action)}</li>
                  ))}
                </ol>
                <h4>{t("documentation.next")}</h4>
                <p>{t(subsection.next)}</p>
              </section>
            )}
            {(section.id === "my-work" || section.id === "settings") && (
              <section aria-labelledby="documentation-events-title">
                <h3 id="documentation-events-title">
                  {t("documentation.notifications.title")}
                </h3>
                <p>{t("documentation.notifications.purpose")}</p>
                <dl className="documentation-effects">
                  {NOTIFICATION_EVENTS.map((event) => (
                    <div key={event}>
                      <dt>
                        <strong>{t(`notifications.event.${event}`)}</strong>{" "}
                        <code>{event}</code>
                      </dt>
                      <dd>{t(`robots.eventHelp.${event}`)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
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
