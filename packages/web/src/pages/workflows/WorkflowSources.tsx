import { RightOutlined } from "@ant-design/icons";
import { Alert, Button, Select, Space, Tag } from "antd";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  loadSkills,
  loadVersions,
  type Skill,
  type SkillVersion,
} from "../../api/skills.js";
import {
  pinSkillVersion,
  unpinSkillVersion,
  type SourceCheckSource,
  type Workflow,
  type WorkflowSkillPin,
  type WorkflowVersion,
  type WorkflowVersionDetail,
} from "../../api/workflows.js";
import { StatusPill } from "../../components/StatusPill.js";
import { useI18n } from "../../i18n/I18nContext.js";
import {
  skillVersionOption,
  skillVersionPath,
} from "../skills/versionDisplay.js";
import { SourcesGate } from "./SourcesGate.js";
import { useInbox } from "../../inbox/InboxContext.js";
import { WorkflowPanel } from "./WorkflowPanel.js";
import { AuthoringStageFinding } from "./AuthoringStageFinding.js";

interface SkillOption {
  skill: Skill;
  versions: SkillVersion[];
}

export function WorkflowSources({
  basePath,
  workflow,
  version,
  detail,
  canManage,
  onChanged,
}: {
  basePath: string;
  workflow: Workflow;
  version: WorkflowVersion;
  detail: WorkflowVersionDetail;
  canManage: boolean;
  onChanged(): void;
}) {
  const i18n = useI18n();
  const { t, format, locale } = i18n;
  const inbox = useInbox();
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (location.hash !== "#sources") return;
    // Let the new tab layout settle before measuring the panel's position.
    const frame = requestAnimationFrame(() => {
      section.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.key, location.hash, workflow.id, version.id]);
  const [options, setOptions] = useState<SkillOption[]>([]);
  const [skillId, setSkillId] = useState<string>();
  const [hash, setHash] = useState<string>();
  const [purpose, setPurpose] = useState<"source" | "upgrade-source">("source");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setPurpose("source");
  }, [workflow.id, version.id]);

  useEffect(() => {
    let cancelled = false;
    void loadSkills(basePath)
      .then(async (catalog) => {
        const groupSkills = catalog.skills.filter(
          (skill) => skill.groupId === workflow.groupId,
        );
        const values = await Promise.all(
          groupSkills.map(async (skill) => ({
            skill,
            versions: (await loadVersions(basePath, skill.id)).versions,
          })),
        );
        if (!cancelled) setOptions(values);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setFailure(
            error instanceof Error
              ? error.message
              : t("workflow.sourcesFailed"),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [basePath, workflow.groupId, t]);

  const selectedVersions = useMemo(
    () =>
      options
        .find((entry) => entry.skill.id === skillId)
        ?.versions.filter((entry) => entry.retiredAt === null) ?? [],
    [options, skillId],
  );
  const currentPin = detail.pins.find((entry) => entry.skillId === skillId);
  const comparison =
    currentPin && hash && currentPin.hash !== hash
      ? `${skillVersionPath(currentPin.skillId, hash)}?${new URLSearchParams({
          tab: "compare",
          from: currentPin.hash,
          to: hash,
        })}`
      : null;

  const pin = async () => {
    if (skillId === undefined || hash === undefined || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await pinSkillVersion(
        basePath,
        workflow.id,
        version.id,
        skillId,
        hash,
        workflow.intent === "upgrade-existing" ? purpose : "source",
        // Replacing a pin quotes the revision this page read.
        currentPin,
      );
      if (result.kind === "ok") {
        setHash(undefined);
        onChanged();
        await inbox.refresh();
      } else setFailure(result.message);
    } finally {
      setBusy(false);
    }
  };

  const unpin = async (pinRecord: WorkflowSkillPin) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await unpinSkillVersion(
        basePath,
        workflow.id,
        version.id,
        pinRecord,
      );
      if (result.kind === "ok") {
        onChanged();
        await inbox.refresh();
      } else setFailure(result.message);
    } finally {
      setBusy(false);
    }
  };

  const check = detail.sourceCheck;
  const sources = new Map(
    check?.sources.map((source) => [source.name, source]),
  );
  const job = detail.jobs.find((entry) => entry.id === check?.jobId);
  const when = (value: string) => new Date(value).toLocaleString(locale);
  return (
    <WorkflowPanel
      title={t("workflow.sources")}
      ref={section}
      id="sources"
      className="workflow-sources"
      aria-labelledby="workflow-sources-title"
      actions={
        check !== null && (
          <StatusPill
            tone={
              check.status === "passed"
                ? "success"
                : check.status === "blocked" || check.status === "failed"
                  ? "danger"
                  : "info"
            }
          >
            {t(`workflow.sourceStatus.${check.status}`)}
          </StatusPill>
        )
      }
    >
      <p className="muted">{t("workflow.sourcesDescription")}</p>
      {canManage && options.length > 0 && (
        <Space wrap className="workflow-pin-form">
          <Select
            aria-label={t("workflow.selectSkill")}
            placeholder={t("workflow.selectSkill")}
            value={skillId}
            onChange={(value) => {
              setSkillId(value);
              setHash(undefined);
              setPurpose("source");
            }}
            options={options.map(({ skill }) => ({
              value: skill.id,
              label: skill.name,
            }))}
          />
          <Select
            aria-label={t("workflow.selectVersion")}
            placeholder={t("workflow.selectVersion")}
            value={hash}
            onChange={setHash}
            disabled={skillId === undefined}
            options={selectedVersions.map((entry) =>
              skillVersionOption(entry, i18n),
            )}
          />
          {workflow.intent === "upgrade-existing" && (
            <Select
              aria-label={t("workflow.pinPurpose")}
              value={purpose}
              onChange={setPurpose}
              options={[
                {
                  value: "source",
                  label: t("workflow.pinPurpose.source"),
                },
                {
                  value: "upgrade-source",
                  label: t("workflow.pinPurpose.upgrade-source"),
                },
              ]}
            />
          )}
          {comparison && <Link to={comparison}>{t("skills.compare")}</Link>}
          <Button
            type="primary"
            disabled={hash === undefined}
            loading={busy}
            onClick={() => void pin()}
          >
            {t(currentPin ? "workflow.replacePin" : "workflow.pin")}
          </Button>
        </Space>
      )}
      <AuthoringStageFinding
        basePath={basePath}
        path={`/workflows/${encodeURIComponent(workflow.id)}/versions/${encodeURIComponent(version.id)}`}
        stage="sources"
      />
      <SourcesGate
        key={detail.version.id}
        basePath={basePath}
        detail={detail}
        onChanged={onChanged}
      />
      {check !== null && (
        <p className="muted">
          {check.finishedAt === null
            ? format("workflow.checkRequested", {
                time: when(check.requestedAt),
              })
            : format("workflow.checkFinished", {
                time: when(check.finishedAt),
              })}
        </p>
      )}
      {check?.status === "failed" && (
        <Alert
          type="error"
          showIcon
          message={t("workflow.checkFailed")}
          description={job?.error ?? undefined}
        />
      )}
      {failure !== null && <Alert type="error" showIcon message={failure} />}
      {detail.pins.length === 0 ? (
        <p className="empty-state">{t("workflow.noPins")}</p>
      ) : (
        <ul className="workflow-pins">
          {detail.pins.map((pinRecord) => (
            <PinnedSourceCard
              key={`${pinRecord.skillId}:${pinRecord.hash}`}
              pin={pinRecord}
              source={sources.get(pinRecord.skillName)}
              unpin={canManage ? () => void unpin(pinRecord) : undefined}
              busy={busy}
            />
          ))}
        </ul>
      )}
      {check !== null && check.blockers.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={t("workflow.blockers")}
          description={
            <ul>
              {check.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          }
        />
      )}
    </WorkflowPanel>
  );
}

function PinnedSourceCard({
  pin,
  source,
  unpin,
  busy,
}: {
  pin: WorkflowSkillPin;
  source: SourceCheckSource | undefined;
  unpin: (() => void) | undefined;
  busy: boolean;
}) {
  const { t } = useI18n();
  const inventoryId = useId();
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="workflow-pin-card">
      <div className="workflow-pin-header">
        <button
          type="button"
          className="workflow-pin-toggle"
          aria-label={pin.skillName}
          aria-expanded={expanded}
          aria-controls={inventoryId}
          aria-describedby={`${inventoryId}-version ${inventoryId}-status`}
          onClick={() => setExpanded((open) => !open)}
        >
          <RightOutlined className="workflow-pin-chevron" aria-hidden="true" />
          <span className="workflow-pin-label">
            <span className="workflow-pin-version">
              <strong>{pin.skillName}</strong>
              {pin.label && <Tag>{pin.label}</Tag>}
              <code id={`${inventoryId}-version`} className="skills-hash">
                {pin.hash}
              </code>
            </span>
            <span id={`${inventoryId}-status`} className="workflow-pin-meta">
              <Tag>{t(`workflow.pinPurpose.${pin.purpose}`)}</Tag>
              {pin.retiredAt && <Tag>{t("workflow.retiredPin")}</Tag>}
              {source && (
                <>
                  <StatusPill
                    tone={source.status === "available" ? "success" : "danger"}
                  >
                    {t(`workflow.sourceState.${source.status}`)}
                  </StatusPill>
                  <Tag>
                    {source.inventory.length} {t("workflow.files")}
                  </Tag>
                </>
              )}
            </span>
          </span>
        </button>
        {unpin && (
          <Button
            className="workflow-pin-unpin"
            danger
            size="small"
            disabled={busy}
            onClick={unpin}
          >
            {t("workflow.unpin")}
          </Button>
        )}
      </div>
      <div
        id={inventoryId}
        className="workflow-pin-inventory"
        hidden={!expanded}
      >
        {expanded && (
          <p>
            <Link to={skillVersionPath(pin.skillId, pin.hash)}>
              {t("workflow.openPin")}
            </Link>
          </p>
        )}
        {expanded &&
          (source ? (
            <>
              {source.inventory.length > 0 && (
                <ul>
                  {source.inventory.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code>
                    </li>
                  ))}
                </ul>
              )}
              {source.ignored.length > 0 && (
                <p className="muted">
                  {t("workflow.ignored")}: {source.ignored.join(", ")}
                </p>
              )}
              {source.scripts.length > 0 && (
                <>
                  <p className="muted">{t("workflow.scripts")}</p>
                  <ul>
                    {source.scripts.map((script) => (
                      <li key={script.path}>
                        <code>{script.path}</code>{" "}
                        {script.sideEffects === "undeclared"
                          ? t("skills.undeclared")
                          : script.sideEffects
                              .map((effect) => t(`skills.effect.${effect}`))
                              .join(", ")}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {source.blockers.length > 0 && (
                <ul>
                  {source.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="muted">{t("workflow.inventoryUnavailable")}</p>
          ))}
      </div>
    </li>
  );
}
