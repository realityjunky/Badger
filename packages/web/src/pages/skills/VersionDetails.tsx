import { Button, Space } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  versionDownloadUrl,
  type Skill,
  type SkillVersion,
  type UploadLimits,
} from "../../api/skills.js";
import { useDemoMode } from "../../app/DemoContext.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { EditSkillFilesDialog } from "./EditSkillFilesDialog.js";
import { RemoveVersionDialog } from "./RemoveVersionDialog.js";
import { UploadSkillModal } from "./UploadSkillModal.js";
import { skillVersionPath } from "./versionDisplay.js";
import { VersionLabelDialog } from "./VersionLabelDialog.js";

export function VersionDetails({
  skill,
  version,
  path,
  limits,
  onUpdated,
  onSaved,
  onDeleted,
}: {
  skill: Skill;
  version: SkillVersion;
  path: string | null;
  limits: UploadLimits;
  onUpdated(version: SkillVersion): void;
  onSaved(version: SkillVersion): void;
  onDeleted(): void;
}) {
  const { t, locale } = useI18n();
  const demo = useDemoMode();
  const [action, setAction] = useState<
    "label" | "edit" | "upload" | "remove" | null
  >(null);
  const subject = new URLSearchParams({
    skill: skill.id,
    skillVersion: version.hash,
  });

  return (
    <>
      <p>{version.description}</p>
      <Space wrap size="middle">
        {!demo && (
          <Button
            href={versionDownloadUrl(
              readBasePath(document),
              skill.id,
              version.hash,
            )}
            download
          >
            {t("skills.downloadZip")}
          </Button>
        )}
        {skill.canUpload && (
          <>
            <Button onClick={() => setAction("edit")}>
              {t("skills.editFiles")}
            </Button>
            <Button onClick={() => setAction("upload")}>
              {t("skills.uploadLocalChanges")}
            </Button>
            <Button onClick={() => setAction("label")}>
              {t("skills.editLabel")}
            </Button>
          </>
        )}
        {!demo && (
          <Link to={`/questionnaire?${subject}`}>
            {t("skills.questionnaire")}
          </Link>
        )}
        {skill.canRemoveVersion && (
          <Button danger onClick={() => setAction("remove")}>
            {t("skills.removeVersion")}
          </Button>
        )}
      </Space>
      <p className="skills-hash">
        {t("skills.hash")} <code>{version.hash}</code>
        {" · "}
        {t("skills.savedDate")}{" "}
        <time dateTime={version.createdAt}>
          {new Date(version.createdAt).toLocaleString(locale)}
        </time>
        {" · "}
        {t(`skills.origin.${version.origin}`)}
      </p>
      {version.gitOrigins.map((origin) => (
        <p
          className="skills-hash"
          key={`${origin.repositoryId}:${origin.commit}`}
        >
          {t("skills.origin.git")} · {origin.repository} ·{" "}
          <code>{origin.commit}</code>
          {origin.ref && <> · {origin.ref}</>}
        </p>
      ))}
      {version.editOrigins?.map((origin) => (
        <p
          className="skills-hash"
          key={`${origin.baseHash}:${origin.method}:${origin.createdAt}`}
        >
          {t(`skills.editOrigin.${origin.method}`)}{" "}
          <Link
            to={skillVersionPath(skill.id, origin.baseHash)}
            title={origin.baseHash}
          >
            <code>{origin.baseHash.slice(0, 12)}</code>
          </Link>
          {" · "}
          <time dateTime={origin.createdAt}>
            {new Date(origin.createdAt).toLocaleString(locale)}
          </time>
        </p>
      ))}
      {action === "label" && (
        <VersionLabelDialog
          version={version}
          onClose={() => setAction(null)}
          onUpdated={onUpdated}
        />
      )}
      {action === "edit" && (
        <EditSkillFilesDialog
          base={version}
          initialPath={path}
          limits={limits}
          onClose={() => setAction(null)}
          onSaved={(created) => {
            setAction(null);
            onSaved(created);
          }}
        />
      )}
      {action === "upload" && (
        <UploadSkillModal
          skill={skill}
          base={version}
          limits={limits}
          onClose={() => setAction(null)}
          onUploaded={(created) => {
            setAction(null);
            onSaved(created);
          }}
        />
      )}
      {action === "remove" && (
        <RemoveVersionDialog
          version={version}
          onClose={() => setAction(null)}
          onRemoved={(updated) => {
            setAction(null);
            if (updated === null) onDeleted();
            else onUpdated(updated);
          }}
        />
      )}
    </>
  );
}
