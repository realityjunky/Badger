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
import { SourceEvidenceDisclosure } from "../../components/SourceEvidenceDisclosure.js";

export interface EvidenceContext {
  basePath: string;
  path: string;
  revision: number;
  pins: DossierPin[];
}

export function DossierEvidenceLinks({
  evidence,
  context,
  collapsible = false,
}: {
  evidence: DossierEvidence[];
  context: EvidenceContext;
  collapsible?: boolean;
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
  const labelCounts = new Map<string, number>();
  for (const reference of references.values()) {
    const text = label(reference);
    labelCounts.set(text, (labelCounts.get(text) ?? 0) + 1);
  }
  const links = (
    <Space wrap size={[8, 4]}>
      {[...references].map(([id, locator]) => {
        const text = label(locator);
        const name =
          (labelCounts.get(text) ?? 0) > 1
            ? pins.find(({ skillId }) => skillId === locator.skillId)?.name
            : undefined;
        return (
          <Button
            key={id}
            onClick={() => {
              setExcerpt(undefined);
              setFailure(undefined);
              setCitation({ locator, revision });
            }}
          >
            {name ? `${name} · ${text}` : text}
          </Button>
        );
      })}
    </Space>
  );
  return (
    <>
      {references.size > 0 &&
        (collapsible ? (
          <SourceEvidenceDisclosure>{links}</SourceEvidenceDisclosure>
        ) : (
          links
        ))}
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
