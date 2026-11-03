import { Alert, Button, Select, Space, Tag } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  loadSkills,
  loadVersions,
  type Skill,
  type SkillVersion,
} from "../../api/skills.js";
import {
  pinSkillVersion,
  unpinSkillVersion,
  type Workflow,
  type WorkflowSkillPin,
  type WorkflowVersion,
  type WorkflowVersionDetail,
} from "../../api/workflows.js";
import { StatusPill } from "../../components/StatusPill.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { SourcesGate } from "./SourcesGate.js";
import { useInbox } from "../../inbox/InboxContext.js";
import { WorkflowPanel } from "./WorkflowPanel.js";

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
  const { t, format, locale } = useI18n();
  const inbox = useInbox();
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (location.hash === "#sources")
      section.current?.scrollIntoView({ block: "start" });
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
    () => options.find((entry) => entry.skill.id === skillId)?.versions ?? [],
    [options, skillId],
  );

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
        detail.pins.find((entry) => entry.skillId === skillId),
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
            <li key={pinRecord.skillId}>
              <div>
                <strong>{pinRecord.skillName}</strong>
                <code className="skills-hash">{pinRecord.hash}</code>
              </div>
              <Space wrap>
                <Tag>{t(`workflow.pinPurpose.${pinRecord.purpose}`)}</Tag>
                {canManage && (
                  <Button
                    danger
                    size="small"
                    disabled={busy}
                    onClick={() => void unpin(pinRecord)}
                  >
                    {t("workflow.unpin")}
                  </Button>
                )}
              </Space>
            </li>
          ))}
        </ul>
      )}
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
            options={selectedVersions.map((entry) => ({
              value: entry.hash,
              label: format("workflow.skillVersion", {
                hash: entry.hash.slice(0, 12),
                date: new Date(entry.createdAt).toLocaleDateString(),
              }),
            }))}
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
          <Button
            type="primary"
            disabled={hash === undefined}
            loading={busy}
            onClick={() => void pin()}
          >
            {t("workflow.pin")}
          </Button>
        </Space>
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
      {check !== null && check.sources.length > 0 && (
        <div className="workflow-source-inventory">
          {check.sources.map((source) => (
            <article key={source.name}>
              <div className="workflow-card-heading">
                <strong>{source.name}</strong>
                <Space wrap>
                  {source.purpose === "upgrade-source" && (
                    <Tag>{t("workflow.pinPurpose.upgrade-source")}</Tag>
                  )}
                  <StatusPill
                    tone={source.status === "available" ? "success" : "danger"}
                  >
                    {t(`workflow.sourceState.${source.status}`)}
                  </StatusPill>
                  <Tag>
                    {source.inventory.length} {t("workflow.files")}
                  </Tag>
                </Space>
              </div>
              <ul>
                {source.inventory.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                  </li>
                ))}
              </ul>
              {source.ignored.length > 0 && (
                <p className="muted">
                  {t("workflow.ignored")}: {source.ignored.join(", ")}
                </p>
              )}
              {source.scripts.length > 0 && (
                <>
                  <p className="muted">{t("workflow.scripts")}</p>
                  <ul className="workflow-source-scripts">
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
                <ul className="workflow-source-blockers">
                  {source.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}
    </WorkflowPanel>
  );
}
