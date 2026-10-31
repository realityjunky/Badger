import { z } from "zod";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  atomicWriteContainedBytes,
  ensureProtectedProjectDirectory,
  inspectProtectedProjectPath,
  readProtectedProjectFile,
  hashDirectory,
  canonicalHash,
  RaceSafeReadError,
  type WorkflowProtocol,
} from "@realityjunky/badger";
import {
  createWorkflowRuntime,
  validateWorkflowMachineVerification,
  workflowGateBinding,
  type WorkflowContinuation,
  type WorkflowDecisionSubmission,
  type WorkflowRunReport,
  type WorkflowMachineSubmission,
} from "@realityjunky/badger/workflow-runtime";
import {
  verifyPublishedPackage,
  publishedPackagePath,
  type PublishedIdentity,
  type PublishedPackageRead,
} from "@realityjunky/badger-hosts";
import {
  BadgerApi,
  BadgerApiError,
  BadgerTimeoutError,
  isRateLimitedBadgerFailure,
  isRetryableBadgerFailure,
} from "./api.js";
import { id, tool } from "./tools.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const local = { projectRoot: z.string().min(1).max(4096), runId: id };
const publication = { workflowId: id, publicationId: id, packageHash: hash };
interface Binding extends PublishedIdentity {
  format: "badger-run-binding-v1";
  deploymentUrl: string;
  personId: string;
  agentHost: string;
  hostLabel: string;
  testRun: boolean;
  registrationId: string;
  localRunId: string;
  packageDirectory: string;
}
interface Queue {
  format: "badger-run-queue-v1";
  identity: Binding;
  lastAcknowledged: number;
  acknowledgedReportHash?: string;
  report: WorkflowRunReport;
}
interface RecoveryQueue {
  required: boolean;
  requests: { requestId: string; noticeId: string | null }[];
  noticeId?: string;
  noticeHash?: string;
}
const BINDING = ".badger/mcp-binding.json",
  QUEUE = ".badger/mcp-queue.json",
  RECOVERY_QUEUE = ".badger/mcp-recovery.json";
const runtime = createWorkflowRuntime();
const label = "Badger MCP Run";
const RECENT_ACCESS_MILLISECONDS = 30_000;
async function read<T>(
  root: string,
  relative: string,
  max = 16 * 1024 * 1024,
): Promise<T | null> {
  const inspection = await inspectProtectedProjectPath(root, relative, {
    label,
    expected: "file",
  });
  if (!inspection.exists) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const value = await readProtectedProjectFile(root, relative, max, {
        label,
      });
      return JSON.parse(value.bytes.toString("utf8")) as T;
    } catch (error) {
      if (
        !(error instanceof RaceSafeReadError) ||
        error.reason !== "changed" ||
        attempt === 2
      )
        throw error;
    }
  }
  throw new Error("The Run queue kept changing; retry the read");
}
async function write(
  root: string,
  relative: string,
  value: unknown,
  exclusive = false,
) {
  await ensureProtectedProjectDirectory(root, path.posix.dirname(relative), {
    label,
  });
  await atomicWriteContainedBytes(
    path.join(root, relative),
    Buffer.from(JSON.stringify(value) + "\n"),
    { containedRoot: root, exclusive },
  );
}
const intent = (runId: string) => `.badger/mcp-starts/${runId}.json`;
function target(args: { projectRoot: string; runId: string }) {
  return {
    kind: "standalone" as const,
    projectRoot: args.projectRoot,
    runId: args.runId,
  };
}
function runRelative(runId: string) {
  return `.badger/runs/${runId}`;
}
function requiresRecovery(current: WorkflowContinuation) {
  return current.findings.some(
    (f) =>
      f.code === "recovery-required" || f.operation?.id === "workflow.recover",
  );
}
/** An interruption's identity: the same one keeps its notice across calls. */
function noticeHash(current: WorkflowContinuation) {
  return canonicalHash({
    binding: workflowGateBinding(current),
    findings: current.findings,
  });
}
async function recoveryQueue(root: string): Promise<RecoveryQueue> {
  const value = await read<RecoveryQueue>(root, RECOVERY_QUEUE);
  if (!value) return { required: false, requests: [] };
  if (
    typeof value.required !== "boolean" ||
    (value.required &&
      (typeof value.noticeId !== "string" ||
        !/^[A-Za-z0-9_-]{1,200}$/u.test(value.noticeId))) ||
    !Array.isArray(value.requests) ||
    value.requests.length > 64 ||
    !value.requests.every(
      (request) =>
        request &&
        typeof request === "object" &&
        typeof request.requestId === "string" &&
        /^[A-Za-z0-9_-]{1,200}$/u.test(request.requestId) &&
        (request.noticeId === null ||
          (typeof request.noticeId === "string" &&
            /^[A-Za-z0-9_-]{1,200}$/u.test(request.noticeId))),
    )
  )
    throw new Error("Invalid durable Run recovery queue");
  return value;
}
async function runRoot(args: { projectRoot: string; runId: string }) {
  if (!path.isAbsolute(args.projectRoot))
    throw new Error("Choose an absolute local project directory");
  const inspected = await inspectProtectedProjectPath(
    args.projectRoot,
    runRelative(args.runId),
    { label, expected: "directory" },
  );
  if (!inspected.exists) throw new Error("This local Run has not started");
  return inspected.target;
}

/** Durable queue entries contain no credentials; the kernel stream repairs a missing queue write. */
export class LocalRuns {
  private readonly active = new Map<
    string,
    { projectRoot: string; runId: string }
  >();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly queueTasks = new Map<string, Promise<unknown>>();
  private readonly gateDeliveries = new Map<
    string,
    Promise<WorkflowContinuation>
  >();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly errors = new Map<string, string>();
  private readonly synchronized = new Set<string>();
  /** The installed package hash each Run last registered in this process. */
  private readonly registered = new Map<string, string | null>();
  /** The recovery notice the service last acknowledged for each Run. */
  private readonly noticed = new Map<string, string>();
  private readonly retries = new Map<string, { count: number; at: number }>();
  /** A rate limit applies to the token, so it pauses every Run's reporting. */
  private limitedUntil = 0;
  private closed = false;
  /** When each binding last passed the service's access check. */
  private readonly authorized = new Map<string, number>();
  constructor(
    private readonly api: BadgerApi,
    private readonly agentHost: string,
  ) {
    this.timer = setInterval(() => {
      for (const args of this.active.values()) this.schedule(args);
    }, 1000);
    this.timer.unref();
  }
  private verify(binding: Binding) {
    if (
      binding.format !== "badger-run-binding-v1" ||
      binding.deploymentUrl !== this.api.url ||
      binding.agentHost !== this.agentHost
    )
      throw new Error(
        "This Run belongs to another Badger deployment or Agent host",
      );
  }
  remember(binding: Binding) {
    this.verify(binding);
    this.authorized.set(canonicalHash(binding), Date.now());
  }
  forgetAuthorization() {
    this.authorized.clear();
  }
  /** A rate limit pauses background reporting until its Retry-After, and a
   * denial clears this binding's successful check. */
  private async request<T>(
    binding: Binding,
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    try {
      return await this.api.request<T>(path, method, body, 1);
    } catch (error) {
      if (isRateLimitedBadgerFailure(error))
        this.limitedUntil = Math.max(
          this.limitedUntil,
          Date.now() + 1000 * (error.retryAfter ?? 1),
        );
      else if (
        error instanceof BadgerApiError &&
        [401, 403].includes(error.status)
      )
        this.authorized.delete(canonicalHash(binding));
      throw error;
    }
  }
  async authorize(binding: Binding, offline = true, recent = false) {
    this.verify(binding);
    const key = canonicalHash(binding);
    // A flush follows the tool call that has just checked this binding, and
    // the service authorizes each of the flush's requests again.
    if (
      recent &&
      Date.now() - (this.authorized.get(key) ?? -Infinity) <
        RECENT_ACCESS_MILLISECONDS
    )
      return;
    try {
      const access = await this.request<{
        personId: string;
        agentHost: string;
      }>(
        binding,
        `/workflows/${encodeURIComponent(binding.workflowId)}/runs/access?testRun=${binding.testRun}`,
      );
      if (
        access.personId !== binding.personId ||
        access.agentHost !== binding.agentHost
      )
        throw new Error(
          "This Run belongs to another signed-in person or Agent host",
        );
      this.authorized.set(key, Date.now());
    } catch (error) {
      // Outages and rate limits are not denials; they keep a successful check.
      const outage = isRetryableBadgerFailure(error);
      if (!outage) this.authorized.delete(key);
      if (offline && outage && this.authorized.has(key)) return;
      throw error;
    }
  }
  async binding(args: { projectRoot: string; runId: string }, recent = false) {
    const root = await runRoot(args);
    let binding = await read<Binding>(root, BINDING);
    if (!binding) {
      binding = await read<Binding>(args.projectRoot, intent(args.runId));
      if (!binding)
        throw new Error("This Run was not started by the Badger MCP");
      this.verify(binding);
      if (!(await runtime.inspect(target(args))))
        throw new Error("This local Run has not started");
      await write(root, BINDING, binding, true);
    }
    this.verify(binding);
    if (binding.localRunId !== args.runId)
      throw new Error("The Run binding does not match this Run");
    const queue = await read<Queue>(root, QUEUE);
    if (
      queue &&
      (queue.format !== "badger-run-queue-v1" ||
        canonicalHash(queue.identity) !== canonicalHash(binding))
    )
      throw new Error("The durable Run queue identity changed");
    await this.authorize(binding, true, recent);
    this.active.set(root, args);
    return { root, binding };
  }
  private async withQueue<T>(
    args: { projectRoot: string; runId: string },
    work: () => Promise<T>,
  ): Promise<T> {
    const key = path.join(args.projectRoot, runRelative(args.runId));
    const previous = this.queueTasks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(work);
    this.queueTasks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.queueTasks.get(key) === task) this.queueTasks.delete(key);
    }
  }
  async reconcile(args: { projectRoot: string; runId: string }) {
    return this.withQueue(args, () => this.reconcileUnlocked(args));
  }
  private async reconcileUnlocked(args: {
    projectRoot: string;
    runId: string;
  }) {
    const root = await runRoot(args);
    const binding = await read<Binding>(root, BINDING);
    if (!binding) throw new Error("Missing local Run binding");
    this.verify(binding);
    const previous = await read<Queue>(root, QUEUE);
    if (
      previous &&
      (previous.format !== "badger-run-queue-v1" ||
        canonicalHash(previous.identity) !== canonicalHash(binding) ||
        !Number.isSafeInteger(previous.lastAcknowledged) ||
        previous.lastAcknowledged < 0)
    )
      throw new Error("The durable Run queue identity changed");
    const lastAcknowledged = previous?.lastAcknowledged ?? 0;
    const report = await runtime.readReport(target(args), lastAcknowledged);
    if (!report) throw new Error("This local Run has not started");
    if (lastAcknowledged > report.lastSequence)
      throw new Error(
        "The Run event stream moved behind its mirror acknowledgement",
      );
    const queue: Queue = {
      format: "badger-run-queue-v1",
      identity: binding,
      lastAcknowledged,
      ...(previous?.acknowledgedReportHash
        ? { acknowledgedReportHash: previous.acknowledgedReportHash }
        : {}),
      report,
    };
    await write(root, QUEUE, queue);
    return queue;
  }
  schedule(args: { projectRoot: string; runId: string }, force = false) {
    if (this.closed || Date.now() < this.limitedUntil) return;
    const key = path.join(args.projectRoot, runRelative(args.runId));
    if (!force && (this.retries.get(key)?.at ?? 0) > Date.now()) return;
    if (this.pending.has(key)) return;
    const work = this.flush(args)
      .then(() => {
        this.errors.delete(key);
        this.retries.delete(key);
      })
      .catch((error: unknown) => {
        const count = (this.retries.get(key)?.count ?? 0) + 1;
        this.retries.set(key, {
          count,
          at: Math.max(
            this.limitedUntil,
            Date.now() + Math.min(30000, 1000 * 2 ** Math.min(count - 1, 5)),
          ),
        });
        // Register again on the next attempt, as for a restored service.
        this.registered.delete(key);
        this.errors.set(
          key,
          error instanceof Error ? error.message : "Run reporting failed",
        );
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
  }
  private async flush(args: { projectRoot: string; runId: string }) {
    const root = await runRoot(args);
    const key = path.join(args.projectRoot, runRelative(args.runId));
    const recovery = await this.withQueue(args, () => recoveryQueue(root));
    if (recovery.required) {
      const current = await runtime.inspect(target(args));
      if (!current) throw new Error("This local Run has not started");
      // While the runtime still needs recovery, the service already holds an
      // acknowledged notice until a new notice or new requests arrive.
      if (
        requiresRecovery(current) &&
        this.noticed.get(key) === recovery.noticeId &&
        recovery.requests.length === 0
      )
        return;
      const { binding } = await this.binding(args, true);
      await this.register(key, binding, current.execution);
      await this.request(
        binding,
        `/runs/${binding.registrationId}/recovery`,
        "POST",
        {
          required: true,
          requestId: recovery.noticeId,
          ...(requiresRecovery(current)
            ? { recoveries: recovery.requests, revision: current.revision }
            : {}),
        },
      );
      this.noticed.set(key, recovery.noticeId!);
      if (requiresRecovery(current)) {
        await this.withQueue(args, async () => {
          const latest = await recoveryQueue(root);
          await write(root, RECOVERY_QUEUE, {
            ...latest,
            requests: latest.requests.filter(
              (request) =>
                !recovery.requests.some(
                  (sent) => sent.requestId === request.requestId,
                ),
            ),
          });
        });
        return;
      }
    }
    let queue = await this.reconcile(args);
    const reportHash = canonicalHash({
      projection: queue.report.projection,
      continuation: queue.report.continuation,
    });
    const localBinding = await read<Binding>(root, BINDING);
    if (!localBinding) throw new Error("Missing local Run binding");
    this.verify(localBinding);
    const observedPackageHash = await hashDirectory(
      localBinding.packageDirectory,
    ).catch(() => null);
    // Changed installed bytes are reported once; the service keeps them flagged
    // until a registration observes the bound bytes again.
    if (
      queue.lastAcknowledged === queue.report.lastSequence &&
      queue.acknowledgedReportHash === reportHash &&
      !recovery.required &&
      recovery.requests.length === 0 &&
      this.synchronized.has(root) &&
      this.registered.has(key) &&
      this.registered.get(key) === observedPackageHash &&
      !this.errors.has(key)
    )
      return;
    const { binding } = await this.binding(args, true);
    await this.register(
      key,
      binding,
      queue.report.continuation.execution,
      observedPackageHash,
    );
    if (this.closed) return;
    const sending = queue.report;
    const events = sending.events;
    // A report of a runtime that needs no recovery settles the notice it was
    // built under: through a request bound to it, or else explicitly. The
    // service settles only that notice, so a late delivery never clears a newer one.
    const settles =
      recovery.required && !requiresRecovery(sending.continuation);
    const settledNoticeId =
      settles &&
      !recovery.requests.some(
        (request) => request.noticeId === recovery.noticeId,
      )
        ? recovery.noticeId
        : undefined;
    // All original events precede the latest snapshot. Intermediate batches never
    // claim a later snapshot while earlier events are still missing.
    for (let offset = 0; offset < events.length || offset === 0;) {
      if (this.closed) return;
      const batch: typeof events = [];
      let bytes = 0;
      while (offset < events.length && batch.length < 64) {
        const event = events[offset];
        const size = Buffer.byteLength(JSON.stringify(event));
        if (batch.length && bytes + size > 768 * 1024) break;
        batch.push(event);
        bytes += size;
        offset++;
      }
      const last = offset >= events.length;
      const response = await this.request<{ lastSequence: number }>(
        binding,
        `/runs/${binding.registrationId}/events`,
        "POST",
        {
          events: batch,
          ...(last
            ? {
                projection: sending.projection,
                continuation: sending.continuation,
                lastSequence: sending.lastSequence,
                recoveryRequired: requiresRecovery(sending.continuation),
                recoveries: recovery.requests,
                ...(settledNoticeId ? { settledNoticeId } : {}),
              }
            : {}),
        },
      );
      // Re-read after the HTTP request so a concurrently committed local transition
      // stays in the queue. Reconciliation can always recreate it after a crash.
      if (this.closed) return;
      await this.withQueue(args, async () => {
        const current = await read<Queue>(root, QUEUE);
        const acknowledged = Math.max(
          current?.lastAcknowledged ?? 0,
          response.lastSequence,
        );
        const latest = await runtime.readReport(target(args), acknowledged);
        if (!latest || this.closed) return;
        queue = {
          ...queue,
          lastAcknowledged: acknowledged,
          ...(last ? { acknowledgedReportHash: reportHash } : {}),
          report: latest,
        };
        await write(root, QUEUE, queue);
        if (last) {
          const latestRecovery = await recoveryQueue(root);
          // Keep a notice until a report settles it, so `recover` binds to it.
          let notice: Omit<RecoveryQueue, "requests"> = latestRecovery.required
            ? {
                required: true,
                noticeId: latestRecovery.noticeId,
                noticeHash: latestRecovery.noticeHash,
              }
            : { required: false };
          if (settles && latestRecovery.noticeId === recovery.noticeId) {
            // The service settled this notice. An interruption that recurred
            // while the report was in flight needs a new one.
            const now = await runtime.inspect(target(args));
            notice =
              now && requiresRecovery(now)
                ? {
                    required: true,
                    noticeId: randomUUID(),
                    noticeHash: noticeHash(now),
                  }
                : { required: false };
          }
          await write(root, RECOVERY_QUEUE, {
            ...notice,
            requests: latestRecovery.requests.filter(
              (request) =>
                !recovery.requests.some(
                  (sent) => sent.requestId === request.requestId,
                ),
            ),
          });
          this.synchronized.add(root);
        }
      });
      if (last) break;
    }
  }
  private async register(
    key: string,
    binding: Binding,
    execution: WorkflowContinuation["execution"],
    observedPackageHash?: string | null,
  ) {
    if (observedPackageHash === undefined)
      observedPackageHash = await hashDirectory(binding.packageDirectory).catch(
        () => null,
      );
    // Registration is idempotent for its fixed identity. Repeat it only when the
    // installed bytes changed or an earlier attempt failed.
    if (
      this.registered.has(key) &&
      this.registered.get(key) === observedPackageHash
    )
      return;
    await this.request(binding, `/runs/${binding.registrationId}`, "POST", {
      workflowId: binding.workflowId,
      publicationId: binding.publicationId,
      packageHash: binding.packageHash,
      observedPackageHash,
      localRunId: binding.localRunId,
      hostLabel: binding.hostLabel,
      testRun: binding.testRun,
      execution,
    });
    this.registered.set(key, observedPackageHash);
  }
  async capture(args: { projectRoot: string; runId: string }) {
    try {
      const current = await runtime.inspect(target(args));
      if (current && requiresRecovery(current)) {
        await this.withQueue(args, async () => {
          const root = await runRoot(args);
          const recovery = await recoveryQueue(root);
          const hash = noticeHash(current);
          await write(root, RECOVERY_QUEUE, {
            ...recovery,
            required: true,
            noticeId:
              recovery.required && recovery.noticeHash === hash
                ? recovery.noticeId
                : randomUUID(),
            noticeHash: hash,
          });
        });
      }
      await this.reconcile(args);
    } catch (error) {
      // The runtime already committed. Preserve its reply and expose reporting
      // failure separately; reconciliation will restore a missing queue later.
      this.errors.set(
        path.join(args.projectRoot, runRelative(args.runId)),
        error instanceof Error ? error.message : "Run reporting failed",
      );
    }
    this.schedule(args, true);
  }
  async recover(args: { projectRoot: string; runId: string }) {
    return this.withQueue(args, async () => {
      const root = await runRoot(args);
      const recovery = await recoveryQueue(root);
      if (recovery.requests.length >= 64)
        throw new Error(
          "Report the queued recovery outcomes before recovering again",
        );
      // Bind the outstanding notice, which stays until a report settles it.
      await write(root, RECOVERY_QUEUE, {
        ...recovery,
        requests: [
          ...recovery.requests,
          {
            requestId: randomUUID(),
            noticeId: recovery.required ? recovery.noticeId! : null,
          },
        ],
      });
      return runtime.recover(target(args));
    });
  }
  async deliverGateAnswer(
    args: { projectRoot: string; runId: string },
    binding: Binding,
    current: WorkflowContinuation,
  ) {
    if (current.pendingAction?.type !== "ask_user") return current;
    const key = path.join(args.projectRoot, runRelative(args.runId));
    const previous = this.gateDeliveries.get(key);
    if (previous) return previous;
    const delivery = this.deliverGateAnswerUnlocked(args, binding, current);
    this.gateDeliveries.set(key, delivery);
    try {
      return await delivery;
    } finally {
      if (this.gateDeliveries.get(key) === delivery)
        this.gateDeliveries.delete(key);
    }
  }
  private async deliverGateAnswerUnlocked(
    args: { projectRoot: string; runId: string },
    binding: Binding,
    current: WorkflowContinuation,
  ) {
    const key = path.join(args.projectRoot, runRelative(args.runId));
    // Flush a newly refreshed gate before asking for its answer. Failed mirroring
    // never makes a response for another revision eligible for local submission.
    this.schedule(args, true);
    await this.pending.get(key);
    let delivery: {
      answer: {
        bindingHash: string;
        submission: WorkflowDecisionSubmission;
      } | null;
    };
    try {
      delivery = await this.request(
        binding,
        `/runs/${binding.registrationId}/gate-answer`,
      );
    } catch (error) {
      if (
        !isRetryableBadgerFailure(error) &&
        !(error instanceof BadgerTimeoutError)
      )
        throw error;
      this.errors.set(key, "Gate delivery is waiting for the Badger service");
      return current;
    }
    const answer = delivery.answer;
    if (
      !answer ||
      answer.bindingHash !== canonicalHash(workflowGateBinding(current))
    )
      return current;
    return runtime.submit(target(args), answer.submission);
  }
  reporting(args: { projectRoot: string; runId: string }) {
    return {
      error:
        this.errors.get(path.join(args.projectRoot, runRelative(args.runId))) ??
        null,
    };
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.pending.values());
    this.active.clear();
  }
}

const submission = z
  .object({
    kind: z.literal("machine").optional(),
    actionId: id,
    status: z.enum(["succeeded", "failed"]),
    summary: z.string().max(50000),
    runId: id.optional(),
    revision: z.number().int().min(0).optional(),
    nodeId: z.string().max(200).nullable().optional(),
    cycleId: z.string().max(200).nullable().optional(),
    attemptId: id.optional(),
    execution: z.record(z.string(), z.unknown()).optional(),
    artifacts: z.record(z.string(), z.string()).optional(),
    state: z.record(z.string(), z.string()).optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
    routing: z.record(z.string(), z.string()).optional(),
    artifactVersions: z.record(z.string(), z.string()).optional(),
    verification: z.unknown().optional(),
    verificationReceipts: z.unknown().optional(),
    verificationReceiptIds: z.array(id).optional(),
    receiptIds: z.array(id).optional(),
  })
  .strict();
export function operatorTools(
  api: BadgerApi,
  runs: LocalRuns,
  agentHost: string,
) {
  async function published(
    identity: PublishedIdentity,
    projectRoot: string,
    install = true,
  ) {
    if (!path.isAbsolute(projectRoot))
      throw new Error("Choose an absolute local project directory");
    const value = await api.request<PublishedPackageRead>(
      publishedPackagePath(identity),
    );
    const snapshot = verifyPublishedPackage(value, identity);
    const file = snapshot.files.find(
      (file) => file.path === "reference/workflow-protocol.json",
    );
    if (!file) throw new Error("Published workflow protocol is missing");
    const protocol = JSON.parse(
      Buffer.from(file.content, "base64").toString("utf8"),
    ) as WorkflowProtocol;
    if (!install) return { protocol, packageDirectory: "" };
    const relative = `.badger/packages/${identity.packageHash}`;
    const existing = await inspectProtectedProjectPath(projectRoot, relative, {
      label: "Published workflow package",
      expected: "directory",
    });
    if (!existing.exists) {
      await ensureProtectedProjectDirectory(projectRoot, relative, { label });
      for (const file of snapshot.files) {
        const at = `${relative}/${file.path}`;
        await ensureProtectedProjectDirectory(
          projectRoot,
          path.posix.dirname(at),
          { label },
        );
        await atomicWriteContainedBytes(
          path.join(projectRoot, at),
          Buffer.from(file.content, "base64"),
          { containedRoot: projectRoot, exclusive: true },
        );
      }
    }
    const packageDirectory = path.join(projectRoot, relative);
    if ((await hashDirectory(packageDirectory)) !== identity.packageHash)
      throw new Error(
        "Local published package bytes changed; restore the exact published package",
      );
    return {
      protocol,
      packageDirectory,
    };
  }
  function result(
    binding: Binding,
    continuation: WorkflowRunReport["continuation"],
    args: { projectRoot: string; runId: string },
  ) {
    const ref = continuation.pendingAction?.ref;
    const skillPath =
      typeof ref === "string" && /^[A-Za-z0-9_-]+$/u.test(ref)
        ? path.join(binding.packageDirectory, ref, "SKILL.md")
        : null;
    return {
      continuation,
      reporting: runs.reporting(args),
      skillPath,
      runUrl: `${api.url}/runs/${binding.registrationId}`,
      ...(continuation.requiresUserDecision ||
      continuation.disposition === "await-user"
        ? {
            requiresPerson: true,
            message:
              "Ask the person to open the Run in Badger. Their gate answer will be delivered on the next next or status call.",
          }
        : {}),
    };
  }
  return [
    tool(
      "start",
      "Start the published workflow after the person confirms. Ask them for every external directory shown by status, then pass externalRoots unchanged.",
      {
        ...local,
        ...publication,
        hostLabel: z.string().min(1).max(200),
        externalRoots: z.record(z.string(), z.string()).optional(),
        testRun: z.boolean().default(false),
        confirmed: z.literal(true),
      },
      async (args) => {
        const { protocol, packageDirectory } = await published(
          args,
          args.projectRoot,
        );
        const access = await api.request<{
          personId: string;
          agentHost: string;
        }>(`/workflows/${args.workflowId}/runs/access?testRun=${args.testRun}`);
        const binding: Binding = {
          format: "badger-run-binding-v1",
          deploymentUrl: api.url,
          personId: access.personId,
          agentHost,
          hostLabel: args.hostLabel,
          testRun: args.testRun,
          registrationId: randomUUID(),
          localRunId: args.runId,
          workflowId: args.workflowId,
          publicationId: args.publicationId,
          packageHash: args.packageHash,
          packageDirectory,
        };
        // Persist identity before the runtime commit; recovery can bind an accepted
        // Run even if the process dies before its queue is first written.
        const existing = await read<Binding>(
          args.projectRoot,
          intent(args.runId),
        );
        if (existing)
          throw new Error(
            "This Run already has a start intent; use status or choose a new Run ID",
          );
        await write(args.projectRoot, intent(args.runId), binding, true);
        runs.remember(binding);
        let continuation;
        try {
          continuation = await runtime.start({
            protocol,
            location: target(args),
            ...(args.externalRoots === undefined
              ? {}
              : { externalRoots: args.externalRoots }),
          });
        } catch (error) {
          // WorkflowRuntime can commit the Run before a later step fails, such as
          // a checkpoint write. Keep that Run's intent so a later call binds it.
          if (await runtime.inspect(target(args)).then(Boolean, () => true))
            throw error;
          // A refused start must permit corrected roots on the same name. No service
          // registration has occurred; the empty intent is safe to remove.
          const { removeContainedFile } = await import("@realityjunky/badger");
          await removeContainedFile(
            path.join(args.projectRoot, intent(args.runId)),
            { containedRoot: args.projectRoot },
          );
          throw error;
        }
        const root = await runRoot(args);
        await write(root, BINDING, binding, true);
        await runs.binding(args);
        await runs.capture(args);
        return result(binding, continuation, args);
      },
      "operateRuns",
      false,
    ),
    tool(
      "status",
      "Read this Run. Before it starts, choose its publication to see the exact external directories and outputs to ask the person for.",
      {
        ...local,
        workflowId: id.optional(),
        publicationId: id.optional(),
        packageHash: hash.optional(),
      },
      async (args) => {
        let current = await runtime.inspect(target(args));
        if (!current) {
          if (!args.workflowId || !args.publicationId || !args.packageHash)
            throw new Error(
              "Choose a published workflow before asking for its start requirements",
            );
          const { protocol } = await published(
            {
              workflowId: args.workflowId,
              publicationId: args.publicationId,
              packageHash: args.packageHash,
            },
            args.projectRoot,
            false,
          );
          return {
            startRequirements: await runtime.startRequirements(protocol),
          };
        }
        const { binding } = await runs.binding(args);
        try {
          if (current.pendingAction?.type === "ask_user") {
            current = await runtime.resume(target(args));
            current = await runs.deliverGateAnswer(args, binding, current);
          }
        } finally {
          await runs.capture(args);
        }
        return {
          ...result(binding, current, args),
          reporting: runs.reporting(args),
        };
      },
      "operateRuns",
      false,
    ),
    tool(
      "next",
      "Read the current Node, its Skill path, required Completion evidence, and pending action.",
      local,
      async (args) => {
        const { binding } = await runs.binding(args);
        let continuation;
        try {
          continuation = await runs.deliverGateAnswer(
            args,
            binding,
            await runtime.resume(target(args)),
          );
        } finally {
          await runs.capture(args);
        }
        return result(binding, continuation, args);
      },
      "operateRuns",
      false,
    ),
    tool(
      "submit",
      "Send this Node's machine evidence and routing to WorkflowRuntime. People answer gates and confirmations in Badger.",
      { ...local, submission },
      async (args) => {
        const { binding } = await runs.binding(args);
        const current = await runtime.inspect(target(args));
        if (
          current?.pendingAction?.type === "ask_user" ||
          current?.requiresUserDecision
        )
          return result(binding, current, args);
        validateWorkflowMachineVerification(
          args.submission as WorkflowMachineSubmission,
        );
        let continuation;
        try {
          continuation = await runtime.submit(
            target(args),
            args.submission as WorkflowMachineSubmission,
          );
        } finally {
          await runs.capture(args);
        }
        return result(binding, continuation, args);
      },
      "operateRuns",
      false,
    ),
    tool(
      "recover",
      "Recover this local Run with WorkflowRuntime. Ask the person to review any pending decision in Badger.",
      local,
      async (args) => {
        const { binding } = await runs.binding(args);
        let continuation;
        try {
          continuation = await runs.recover(args);
        } finally {
          await runs.capture(args);
        }
        return result(binding, continuation, args);
      },
      "operateRuns",
      false,
    ),
    tool(
      "my_runs",
      "List your Runs reported to Badger, with their status and dashboard links.",
      {},
      () => api.request("/me/runs"),
      "operateRuns",
      true,
    ),
  ];
}
