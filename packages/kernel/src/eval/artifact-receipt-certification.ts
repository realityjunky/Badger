import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { generatePackage } from "../factory/generate.js";
import { normalizeWorkflow } from "../workflow/contract.js";
import {
  createWorkflowRuntime,
  type WorkflowContinuation,
} from "../workflow-runtime/public.js";
import type {
  WorkflowInput,
  WorkflowArtifactReceipt,
  WorkflowRuntimeArtifactReceiptCertificationEvidence,
} from "../types.js";
import { hashDirectory, stableValue } from "../util.js";

const execFileAsync = promisify(execFile);
const LARGE_FILE_HASH =
  "6f850bc94ae6f7de14297c01616c36d712d22864497b28a63b81d776b035e656";

function receiptInput(): WorkflowInput {
  return {
    kind: "workflow-kernel",
    name: "artifact-receipt-certification-workflow",
    goal: "Certify receipts for external and large artifacts.",
    customNodes: [
      {
        id: "produce",
        label: "Produce",
        kind: "action",
        responsibility: "Produce the synthetic artifact.",
        implementation: {
          skill: "synthetic-producer",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: ["result.v1"],
        guardrails: [],
      },
    ],
    outputSchemas: [
      {
        id: "result.v1",
        description: "Synthetic artifact receipts.",
        externalRoots: {
          outputs: { description: "Where the synthetic producer writes." },
        },
        artifacts: [
          {
            id: "result",
            kind: "file",
            required: true,
            paths: ["result.bin"],
            validations: ["artifact-exists"],
            verification: "receipt",
            root: "outputs",
            requireCurrentAttempt: true,
          },
        ],
        evidence: [],
      },
    ],
  };
}

function success(current: WorkflowContinuation) {
  return {
    runId: current.runId,
    revision: current.revision,
    execution: current.execution,
    actionId: current.pendingAction!.id,
    nodeId: current.currentNode,
    status: "succeeded" as const,
    summary: "Produced the synthetic artifact.",
  };
}

export async function certifyArtifactReceipts(options: {
  generatedPackageHash: string;
}): Promise<{
  evidence: WorkflowRuntimeArtifactReceiptCertificationEvidence;
  blockers: string[];
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-receipt-certification-"),
  );
  const evidence: WorkflowRuntimeArtifactReceiptCertificationEvidence = {
    status: "failed",
    generatedPackageHash: options.generatedPackageHash,
    fixtureName: "artifact-receipt-certification-workflow",
    externalRoot: false,
    rootBindingRequired: false,
    largeFile: false,
    completionEvidence: false,
    staleRejected: false,
    containmentRejected: false,
    legacyRunRoot: false,
    freshProcessRecovered: false,
    sourceIntegrity: false,
  };
  try {
    const externalRoot = path.join(root, "outputs");
    await fs.mkdir(externalRoot);
    const input = receiptInput();
    const protocol = normalizeWorkflow(input).protocol;
    const generated = await generatePackage({
      proposal: {
        schemaVersion: 1,
        name: protocol.name,
        goal: protocol.goal,
        intent: "new-skill",
        planHash: "artifact-receipt-certification-plan",
        proposalHash: "artifact-receipt-certification-proposal",
        workflow: protocol,
        candidates: [],
        blockers: [],
        warnings: [],
        canInitialize: true,
      },
      plan: {
        schemaVersion: 1,
        goal: protocol.goal,
        skillCreatorIntent: "new-skill",
        skillSources: [],
        workflow: input,
        defaultLocale: "en",
      },
      projectRoot: root,
      destination: path.join(root, "generated"),
    });
    // The fixture's contents must not change while it runs.
    const fixturePackageHash = await hashDirectory(generated.packageRoot);
    const runtime = createWorkflowRuntime();
    // A declared root without a directory refuses the Run before it exists.
    const unboundRoot = path.join(root, "unbound-run");
    const unbound = await runtime
      .start({ protocol, runRoot: unboundRoot, runId: "unbound-receipt" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    evidence.rootBindingRequired =
      unbound instanceof Error &&
      /needs a directory when the Run starts/u.test(unbound.message) &&
      !(await fs.stat(unboundRoot).then(
        () => true,
        () => false,
      ));
    const runRoot = path.join(root, "run");
    const environment = { PATH: process.env.PATH };
    const started = JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [
            path.join(generated.packageRoot, "scripts", "workflow-state.mjs"),
            "init",
            "--run-root",
            runRoot,
            "--run-id",
            "receipt-certification",
            "--external-root",
            `outputs=${externalRoot}`,
            "--json",
          ],
          { cwd: generated.packageRoot, env: environment },
        )
      ).stdout,
    ) as WorkflowContinuation;
    const artifactPath = path.join(externalRoot, "result.bin");
    await fs.writeFile(artifactPath, "stale\n");
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(artifactPath, oldTime, oldTime);
    const stale = await runtime.submit(runRoot, success(started));
    evidence.staleRejected =
      stale.disposition === "blocked" &&
      stale.revision === started.revision &&
      stale.pendingAction?.id === started.pendingAction?.id &&
      stale.findings.some(
        (finding) => finding.code === "artifact-stale-attempt",
      );
    await fs.writeFile(artifactPath, Buffer.alloc(3 * 1024 * 1024, "a"));
    const completed = await runtime.submit(runRoot, success(started));
    const receipt = (
      completed.visits[0]?.outcomes[0]?.evidence?.artifactReceipts as
        WorkflowArtifactReceipt[] | undefined
    )?.[0];
    evidence.externalRoot =
      completed.disposition === "done" &&
      receipt?.path === artifactPath &&
      receipt.root?.name === "outputs" &&
      receipt.root.path === externalRoot;
    evidence.largeFile = receipt?.size === 3 * 1024 * 1024;
    evidence.completionEvidence =
      receipt?.sha256 === LARGE_FILE_HASH &&
      receipt.producer.attemptId === started.attemptId &&
      receipt.producer.actionId === started.pendingAction?.id &&
      Math.abs(receipt.mtimeMs - (await fs.stat(artifactPath)).mtimeMs) < 0.001;
    const recovered = JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "const m = await import(process.argv[1]); console.log(JSON.stringify(await m.createWorkflowRuntime().recover(process.argv[2])));",
            pathToFileURL(
              path.join(
                generated.packageRoot,
                "scripts",
                "workflow-runtime.mjs",
              ),
            ).href,
            runRoot,
          ],
          { cwd: generated.packageRoot, env: environment },
        )
      ).stdout,
    ) as WorkflowContinuation;
    evidence.freshProcessRecovered =
      recovered.disposition === "done" &&
      JSON.stringify(stableValue(recovered.visits)) ===
        JSON.stringify(stableValue(completed.visits));

    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "result.bin"), "outside\n");
    await fs.symlink(
      outside,
      path.join(externalRoot, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const unsafeInput = structuredClone(input);
    unsafeInput.outputSchemas![0].artifacts[0].paths = ["escape/result.bin"];
    const unsafeRoot = path.join(root, "unsafe-run");
    const unsafe = await runtime.start({
      protocol: normalizeWorkflow(unsafeInput).protocol,
      runRoot: unsafeRoot,
      runId: "unsafe-receipt",
      externalRoots: { outputs: externalRoot },
    });
    const refused = await runtime.submit(unsafeRoot, success(unsafe));
    evidence.containmentRejected =
      refused.disposition === "blocked" &&
      refused.revision === unsafe.revision &&
      refused.blockers.some((blocker) =>
        /symbolic link|junction/u.test(blocker),
      );

    const legacyInput = structuredClone(input);
    delete legacyInput.outputSchemas![0].externalRoots;
    const legacyArtifact = legacyInput.outputSchemas![0].artifacts[0];
    delete legacyArtifact.verification;
    delete legacyArtifact.root;
    delete legacyArtifact.requireCurrentAttempt;
    const legacyRoot = path.join(root, "legacy-run");
    const legacy = await runtime.start({
      protocol: normalizeWorkflow(legacyInput).protocol,
      runRoot: legacyRoot,
      runId: "legacy-receipt",
    });
    await fs.writeFile(
      path.join(legacyRoot, "result.bin"),
      Buffer.alloc(3 * 1024 * 1024, "a"),
    );
    const oversized = await runtime.submit(legacyRoot, success(legacy));
    await fs.writeFile(path.join(legacyRoot, "result.bin"), "legacy\n");
    const legacyCompleted = await runtime.submit(legacyRoot, success(legacy));
    evidence.legacyRunRoot =
      oversized.disposition === "blocked" &&
      oversized.findings.some(
        (finding) => finding.code === "artifact-oversized",
      ) &&
      legacyCompleted.disposition === "done";
    evidence.sourceIntegrity =
      fixturePackageHash === (await hashDirectory(generated.packageRoot));
    const complete =
      evidence.externalRoot &&
      evidence.rootBindingRequired &&
      evidence.largeFile &&
      evidence.completionEvidence &&
      evidence.staleRejected &&
      evidence.containmentRejected &&
      evidence.legacyRunRoot &&
      evidence.freshProcessRecovered &&
      evidence.sourceIntegrity;
    evidence.status = complete ? "certified" : "failed";
    return {
      evidence,
      blockers: complete
        ? []
        : ["WorkflowRuntime artifact receipt certification is incomplete"],
    };
  } catch (error) {
    return {
      evidence,
      blockers: [
        `WorkflowRuntime artifact receipt certification failed: ${(error as Error).message}`,
      ],
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
