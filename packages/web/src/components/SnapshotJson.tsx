import { Space } from "antd";
import { useMemo, useState } from "react";
import { useI18n } from "../i18n/I18nContext.js";

type Document = Record<string, unknown>;

/** Selecting a section and indenting JSON affect only the reading view. */
export function SnapshotJson(
  props:
    { canonical: string; data?: never } | { data: Document; canonical?: never },
) {
  const { t } = useI18n();
  const [original, setOriginal] = useState(false);
  const [section, setSection] = useState("");
  const document: Document = useMemo(
    () => props.data ?? JSON.parse(props.canonical!),
    [props.data, props.canonical],
  );
  const formatted = useMemo(
    () => JSON.stringify(section ? document[section] : document, null, 2),
    [document, section],
  );
  return (
    <>
      <Space wrap>
        <label className="snapshot-format">
          {t("dossier.jsonSection")}
          <select
            value={original ? "" : section}
            disabled={original}
            onChange={(event) => setSection(event.target.value)}
          >
            <option value="">{t("dossier.fullJson")}</option>
            {Object.keys(document).map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        {props.canonical !== undefined && (
          <label className="snapshot-format">
            <input
              type="checkbox"
              checked={original}
              onChange={(event) => setOriginal(event.target.checked)}
            />
            {t("dossier.originalJson")}
          </label>
        )}
      </Space>
      <pre className="dossier-json">
        {original ? props.canonical : formatted}
      </pre>
    </>
  );
}
