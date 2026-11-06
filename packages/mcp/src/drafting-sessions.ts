import { BadgerApi, BadgerApiError } from "./api.js";

export interface DraftingSession {
  workflowId: string;
  versionId: string;
  jobId: string;
  leaseId: string;
  contextHash: string;
}

export class LocalDraftingSessions {
  private readonly active = new Map<string, DraftingSession>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private limitedUntil = 0;
  private closing: Promise<void> | undefined;

  constructor(private readonly api: BadgerApi) {
    this.timer = setInterval(() => {
      if (Date.now() < this.limitedUntil) return;
      for (const session of this.active.values()) this.renew(session);
    }, 5 * 60_000);
    this.timer.unref();
  }

  private path(session: DraftingSession) {
    return `/workflows/${encodeURIComponent(session.workflowId)}/versions/${encodeURIComponent(session.versionId)}/drafting-jobs/${encodeURIComponent(session.jobId)}`;
  }

  remember(session: DraftingSession) {
    if (this.closing) throw new Error("The drafting session is closing");
    this.active.set(this.path(session), session);
  }

  owns(session: DraftingSession) {
    return this.active.get(this.path(session))?.leaseId === session.leaseId;
  }

  forget(session: DraftingSession) {
    if (this.owns(session)) this.active.delete(this.path(session));
  }

  private renew(session: DraftingSession) {
    const route = this.path(session);
    if (this.pending.has(route)) return;
    const renewal = this.api
      .request(
        `${route}/renew`,
        "POST",
        {
          leaseId: session.leaseId,
          contextHash: session.contextHash,
        },
        1,
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        if (error instanceof BadgerApiError) {
          if ([401, 403, 404, 409].includes(error.status)) this.forget(session);
          if (error.status === 429)
            this.limitedUntil = Date.now() + (error.retryAfter ?? 1) * 1000;
        }
      })
      .finally(() => this.pending.delete(route));
    this.pending.set(route, renewal);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.timer);
    this.closing = (async () => {
      await Promise.allSettled(this.pending.values());
      await Promise.allSettled(
        [...this.active.values()].map((session) =>
          this.api.request(
            `${this.path(session)}/release`,
            "POST",
            {
              leaseId: session.leaseId,
              contextHash: session.contextHash,
            },
            1,
          ),
        ),
      );
      this.active.clear();
    })();
    return this.closing;
  }
}
