import { useEffect, useRef, useState } from "react";
import type { DraftingJob, DraftingResult } from "../../api/drafting-jobs.js";
import {
  QuestionnaireError,
  questionnaireRequest,
} from "../../api/questionnaire.js";
import { apiUrl } from "../../app/paths.js";

interface DraftingReviewSession {
  job: DraftingJob;
  result: DraftingResult | null;
  leaseId: string | null;
  ended: boolean;
}

export function useDraftingReview(
  basePath: string,
  jobsPath: string,
  jobs: DraftingJob[],
  onChanged: () => Promise<void>,
) {
  const [review, setReview] = useState<DraftingReviewSession | null>(null);
  const current = useRef(review);
  current.current = review;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const activity = useRef(0);
  const reportedActivity = useRef(0);
  const pending = useRef(false);
  const markActivity = () => {
    const previous = activity.current;
    const observedActivity = Date.now();
    activity.current = observedActivity;
    const session = current.current;
    if (
      !session?.leaseId ||
      session.ended ||
      observedActivity - previous < 15_000
    )
      return;
    void questionnaireRequest(
      basePath,
      `${jobsPath}/${session.job.id}/renew`,
      "POST",
      {
        ...leaseBody(session),
        active: true,
      },
    )
      .then(() => {
        reportedActivity.current = Math.max(
          reportedActivity.current,
          observedActivity,
        );
      })
      .catch((error: unknown) => {
        if (
          error instanceof QuestionnaireError &&
          [401, 403, 404, 409].includes(error.status)
        )
          end(session);
      });
  };
  const leaseBody = (session: DraftingReviewSession) => ({
    leaseId: session.leaseId,
    contextHash: session.job.contextHash,
  });
  const end = (session: DraftingReviewSession) => {
    setReview((latest) =>
      latest?.leaseId === session.leaseId ? { ...latest, ended: true } : latest,
    );
  };

  useEffect(() => {
    if (!review || review.ended) return;
    const job = jobs.find((entry) => entry.id === review.job.id);
    if (!review.leaseId) {
      if (job && job.revision > review.job.revision)
        setReview((latest) =>
          latest?.leaseId === null && latest.job.id === job.id
            ? {
                ...latest,
                job,
                result: structuredClone(job.review?.result ?? job.result),
              }
            : latest,
        );
      return;
    }
    if (
      job &&
      job.revision >= review.job.revision &&
      (job.status !== "claimed" ||
        job.lease?.claimHash !== review.job.lease?.claimHash)
    )
      end(review);
  }, [jobs, review?.job.id, review?.leaseId]);

  useEffect(() => {
    current.current = null;
    setReview(null);
    const releaseOnExit = () => {
      const session = current.current;
      if (!session?.leaseId || session.ended) return;
      void fetch(apiUrl(basePath, `${jobsPath}/${session.job.id}/release`), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...leaseBody(session),
          reason: "editor-closed",
        }),
        keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", releaseOnExit);
    return () => {
      window.removeEventListener("pagehide", releaseOnExit);
      releaseOnExit();
    };
  }, [basePath, jobsPath]);

  useEffect(() => {
    let renewing = false;
    const timer = window.setInterval(() => {
      const session = current.current;
      if (!session?.leaseId || session.ended || pending.current || renewing)
        return;
      renewing = true;
      const idle = Date.now() - activity.current >= 30 * 60_000;
      const observedActivity = activity.current;
      void questionnaireRequest<{ job: DraftingJob }>(
        basePath,
        `${jobsPath}/${session.job.id}/${idle ? "release" : "renew"}`,
        "POST",
        {
          ...leaseBody(session),
          ...(idle
            ? { reason: "idle" }
            : {
                active: observedActivity > reportedActivity.current,
              }),
        },
      )
        .then(async () => {
          reportedActivity.current = observedActivity;
          if (idle) {
            end(session);
            await changed.current();
          }
        })
        .catch((error: unknown) => {
          if (
            error instanceof QuestionnaireError &&
            [401, 403, 404, 409].includes(error.status)
          )
            end(session);
        })
        .finally(() => {
          renewing = false;
        });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [basePath, jobsPath]);

  async function open(job: DraftingJob) {
    const { job: latest } = await questionnaireRequest<{ job: DraftingJob }>(
      basePath,
      `${jobsPath}/${job.id}`,
    );
    if (job.status === "claimed" || latest.status === "claimed") {
      const session: DraftingReviewSession = {
        job: latest,
        result: structuredClone(latest.review?.result ?? latest.result),
        leaseId: null,
        ended: false,
      };
      current.current = session;
      setReview(session);
      await changed.current();
      return;
    }
    const claimed = await questionnaireRequest<{
      job: DraftingJob & {
        lease: NonNullable<DraftingJob["lease"]> & { id: string };
      };
    }>(basePath, `${jobsPath}/${job.id}/review-claim`, "POST", {
      revision: latest.revision,
    });
    const session: DraftingReviewSession = {
      job: claimed.job,
      result: structuredClone(
        claimed.job.review?.result ?? claimed.job.result!,
      ),
      leaseId: claimed.job.lease.id,
      ended: false,
    };
    activity.current = reportedActivity.current = Date.now();
    current.current = session;
    setReview(session);
    await changed.current();
  }

  async function save() {
    const session = current.current;
    if (!session?.leaseId || !session.result || session.ended) return null;
    pending.current = true;
    try {
      const { job } = await questionnaireRequest<{ job: DraftingJob }>(
        basePath,
        `${jobsPath}/${session.job.id}/review`,
        "POST",
        {
          ...leaseBody(session),
          revision: session.job.revision,
          result: session.result,
        },
      );
      const saved = { ...session, job };
      current.current = saved;
      setReview(saved);
      activity.current = reportedActivity.current = Date.now();
      await changed.current();
      return saved;
    } catch (error) {
      if (
        error instanceof QuestionnaireError &&
        [401, 403, 404, 409].includes(error.status)
      )
        end(session);
      throw error;
    } finally {
      pending.current = false;
    }
  }

  async function close(finish = false) {
    const session = finish ? await save() : current.current;
    if (!session) return;
    pending.current = true;
    try {
      if (session.leaseId && !session.ended) {
        try {
          await questionnaireRequest(
            basePath,
            `${jobsPath}/${session.job.id}/${finish ? "finish" : "release"}`,
            "POST",
            {
              ...leaseBody(session),
              ...(finish ? {} : { reason: "editor-closed" }),
            },
          );
        } catch (error) {
          if (!(error instanceof QuestionnaireError && error.status === 409))
            throw error;
        }
      }
      current.current = null;
      setReview(null);
      if (session.leaseId) await changed.current();
    } finally {
      pending.current = false;
    }
  }

  return { review, setReview, open, save, close, markActivity };
}
