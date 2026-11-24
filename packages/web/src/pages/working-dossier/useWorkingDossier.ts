import type { WorkingDossierView } from "@realityjunky/badger";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  QuestionnaireError,
  questionnaireRequest,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useLiveUpdates } from "../../live/LiveUpdatesContext.js";

export function useWorkingDossier(
  basePath: string,
  path: string | null,
  versionId: string | undefined,
  active = true,
) {
  const { t } = useI18n();
  const { connected, notice } = useLiveUpdates();
  const [loaded, setLoaded] = useState<{
    path: string;
    dossier: WorkingDossierView;
  }>();
  const [failure, setFailure] = useState<string>();
  const request = useRef<{ path: string; controller: AbortController }>(null);

  const accept = useCallback(
    (dossier: WorkingDossierView) => {
      if (path === null) return;
      if (request.current && request.current.path !== path) return;
      request.current?.controller.abort();
      setLoaded((current) =>
        current?.path === path && current.dossier.revision > dossier.revision
          ? current
          : { path, dossier },
      );
      setFailure(undefined);
    },
    [path],
  );

  const reload = useCallback(async () => {
    if (path === null) return;
    request.current?.controller.abort();
    const controller = new AbortController();
    request.current = { path, controller };
    try {
      const dossier = await questionnaireRequest<WorkingDossierView>(
        basePath,
        path,
        "GET",
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) accept(dossier);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (
        error instanceof QuestionnaireError &&
        [401, 403, 404].includes(error.status)
      )
        setLoaded(undefined);
      setFailure(error instanceof Error ? error.message : t("dossier.failed"));
    }
  }, [accept, basePath, path, t]);

  useEffect(() => {
    if (path === null || !active) return;
    void reload();
    function refreshOnFocus() {
      if (!document.hidden) void reload();
    }
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      request.current?.controller.abort();
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [active, path, reload]);

  useEffect(() => {
    if (path === null || !active || connected) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void reload();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [active, connected, path, reload]);

  useEffect(() => setFailure(undefined), [path]);

  useEffect(() => {
    if (active && versionId && notice.versionIds.includes(versionId))
      void reload();
  }, [active, notice, reload, versionId]);

  return {
    dossier: path === loaded?.path ? loaded?.dossier : undefined,
    failure,
    accept,
    reload,
  };
}
