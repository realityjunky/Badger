import { Alert, Button, Modal, Space, Spin } from "antd";
import { useEffect, useState } from "react";
import type { DossierEvidence, DossierPin } from "@realityjunky/badger";
import {
  dossierEvidenceKey,
  dossierEvidencePath,
  type WorkingDossierExcerpt,
} from "../../api/working-dossier.js";
import { questionnaireRequest } from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";

export interface EvidenceContext {
  basePath: string;
  path: string;
  revision: number;
  pins: DossierPin[];
}

export function DossierEvidenceLinks({
  evidence,
  context,
}: {
  evidence: DossierEvidence[];
  context: EvidenceContext;
}) {
  const { t } = useI18n();
  const [citation, setCitation] = useState<{
    locator: DossierEvidence;
    revision: number;
  }>();
  const [excerpt, setExcerpt] = useState<WorkingDossierExcerpt>();
  const [failure, setFailure] = useState<string>();
  const { basePath, path, revision, pins } = context;

  useEffect(() => {
    if (!citation) return;
    const controller = new AbortController();
    void questionnaireRequest<WorkingDossierExcerpt>(
      basePath,
      dossierEvidencePath(path, citation.revision, citation.locator),
      "GET",
      undefined,
      controller.signal,
    ).then(
      (result) => {
        if (!controller.signal.aborted) setExcerpt(result);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error
              ? error.message
              : t("workingDossier.evidenceFailed"),
          );
      },
    );
    return () => controller.abort();
  }, [basePath, path, citation, t]);

  if (!evidence.length && !citation) return null;
  const references = new Map(
    evidence.map((locator) => [dossierEvidenceKey(locator), locator]),
  );
  const locator = citation?.locator;
  const pin = pins.find((pin) => pin.skillId === locator?.skillId);
  const label = ({ path, startLine, endLine }: DossierEvidence) =>
    `${path}:L${startLine}${endLine === startLine ? "" : `–L${endLine}`}`;
  return (
    <>
      <Space wrap size={[8, 4]}>
        {[...references].map(([id, locator]) => (
          <Button
            key={id}
            onClick={() => {
              setExcerpt(undefined);
              setFailure(undefined);
              setCitation({ locator, revision });
            }}
          >
            {label(locator)}
          </Button>
        ))}
      </Space>
      {locator && (
        <Modal
          open
          width={820}
          title={label(locator)}
          footer={null}
          onCancel={() => setCitation(undefined)}
        >
          <dl className="working-dossier-evidence-meta">
            <dt>{pin?.name ?? locator.skillId}</dt>
            <dd>
              <code>{locator.hash}</code>
            </dd>
            <dt>{t("workingDossier.fileHash")}</dt>
            <dd>
              <code>{locator.fileHash}</code>
            </dd>
          </dl>
          {failure ? (
            <Alert type="error" showIcon title={failure} />
          ) : excerpt ? (
            <pre className="working-dossier-excerpt">
              {excerpt.lines.map((line) => (
                <span key={line.number}>
                  <span className="working-dossier-line-number">
                    {line.number}
                  </span>
                  <code>{line.text || " "}</code>
                </span>
              ))}
            </pre>
          ) : (
            <Spin aria-label={t("common.loading")} />
          )}
        </Modal>
      )}
    </>
  );
}
