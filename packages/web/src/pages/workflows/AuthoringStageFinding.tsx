import { Alert } from "antd";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type {
  AuthoringLaneAction,
  AuthoringLaneFinding,
  AuthoringRepairTarget,
} from "@realityjunky/badger";
import { questionnaireRequest } from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { skillVersionPath } from "../skills/versionDisplay.js";
import { selectedWorkflowTab } from "./WorkflowTabs.js";

interface Finding {
  jobId: string;
  laneId: string;
  targetHash: string;
  action: AuthoringLaneAction;
  findings: AuthoringLaneFinding[];
}

export function AuthoringStageFinding({
  basePath,
  path,
  stage,
}: {
  basePath: string;
  path: string;
  stage: AuthoringRepairTarget["stage"];
}) {
  const { t, format } = useI18n();
  const location = useLocation();
  const jobId =
    selectedWorkflowTab(location) === stage
      ? new URLSearchParams(location.search).get("authoringFinding")
      : null;
  const [value, setValue] = useState<Finding | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    setValue(null);
    setFailure(null);
    if (!jobId) return;
    const controller = new AbortController();
    void questionnaireRequest<{ finding: Finding }>(
      basePath,
      `${path}/package/authoring?finding=${encodeURIComponent(jobId)}`,
      "GET",
      undefined,
      controller.signal,
    ).then(
      ({ finding }) => {
        if (!controller.signal.aborted) setValue(finding);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error ? error.message : t("package.failed"),
          );
      },
    );
    return () => controller.abort();
  }, [basePath, path, jobId, t]);

  if (jobId && failure) return <Alert type="error" showIcon title={failure} />;
  const target = value?.action.target;
  if (!value || value.jobId !== jobId || target?.stage !== stage) return null;
  return (
    <Alert
      type="info"
      showIcon
      title={format("authoring.findingOrigin", { lane: value.laneId })}
      description={
        <>
          <p>{value.action.requirement}</p>
          <p>{value.action.prompt}</p>
          {target.stage === "dossier" && (
            <p>
              <code>{target.field}</code>
            </p>
          )}
          {target.stage === "proposal" && (
            <p>
              <code>{value.targetHash}</code>
            </p>
          )}
          {value.findings.length > 0 && (
            <ul>
              {value.findings.map((finding, index) => (
                <li key={index}>
                  {finding.path && (
                    <>
                      <code>{finding.path}</code>{" "}
                    </>
                  )}
                  {finding.problem}
                </li>
              ))}
            </ul>
          )}
          {target.stage === "sources" && (
            <p>
              <Link to={skillVersionPath(target.skillId, target.skillHash)}>
                {t("authoring.openReviewedSkill")}
              </Link>
            </p>
          )}
          <Link to={{ search: "", hash: "#package" }}>
            {t("authoring.backToPackage")}
          </Link>
        </>
      }
    />
  );
}
