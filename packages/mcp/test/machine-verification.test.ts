import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createPackageSnapshot,
  generatePackage,
  normalizeWorkflow,
  type WorkflowInput,
} from "@realityjunky/badger";
import { createWorkflowRuntime } from "@realityjunky/badger/workflow-runtime";
import { createBadgerMcp } from "../src/index.js";

it("refuses every manual verification representation without advancing and accepts a legitimate machine receipt through MCP", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-machine-verification-"),
  );
  const workflow: WorkflowInput = {
    kind: "workflow-kernel",
    name: "machine-verification",
    goal: "Verify machine evidence without human sign-off.",
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
      durability: {
        version: 1,
        capabilities: [
          "mutation-locks",
          "revision-fences",
          "transition-journal",
          "verification-receipts",
        ],
        bounds: {
          runStateBytes: 256 * 1024,
          pendingActionBytes: 256 * 1024,
          trajectoryBytes: 8 * 1024 * 1024,
          artifactsBytes: 1024 * 1024,
          claimBytes: 16 * 1024,
          transitionJournalBytes: 1024 * 1024,
          runLockBytes: 16 * 1024,
          verificationReceiptBytes: 256 * 1024,
          verificationReceiptCount: 8,
        },
        schemaVersions: {
          runState: 1,
          pendingAction: 1,
          trajectory: 1,
          artifacts: 1,
          revisionClaim: 1,
          transitionJournal: 1,
          runLock: 1,
          verificationReceipt: 1,
        },
        findingCatalogVersion: 1,
        verificationPolicy: { maxSummaryBytes: 1024, maxEvidenceBytes: 2048 },
      },
    },
    customNodes: [
      {
        id: "check",
        label: "Check",
        kind: "action",
        responsibility: "Check the evidence.",
        implementation: {
          skill: "checker",
          operation: "default",
          scope: "main",
        },
        operations: ["require"],
        outputSchemas: [],
        guardrails: [
          {
            id: "verified",
            label: "Verified evidence",
            validation: "semantic",
            verification: {
              role: "workflow-check",
              kind: ["automated-check", "manual-evidence"],
            },
          },
        ],
      },
    ],
  };
  const protocol = normalizeWorkflow(workflow).protocol;
  const generated = await generatePackage({
    projectRoot: root,
    destination: path.join(root, "package"),
    plan: {
      schemaVersion: 1,
      goal: workflow.goal,
      skillCreatorIntent: "new-skill",
      skillSources: [],
      workflow,
      defaultLocale: "en",
    },
    proposal: {
      schemaVersion: 1,
      name: workflow.name,
      goal: workflow.goal,
      intent: "new-skill",
      planHash: "plan",
      proposalHash: "proposal",
      workflow: protocol,
      candidates: [],
      blockers: [],
      warnings: [],
      canInitialize: true,
    },
  });
  const snapshot = await createPackageSnapshot(
    generated.packageRoot,
    generated.inventory,
  );
  const server = createBadgerMcp({
    url: "https://badger.example/team",
    token: "test-token",
    agentHost: "Verification Agent",
    profile: "operator",
    fetch: async (url, init) => {
      if (url.endsWith("/me/mcp"))
        return Response.json({ capabilities: { operateRuns: true } });
      if (url.includes("/runs/access?"))
        return Response.json({
          personId: "operator",
          agentHost: "Verification Agent",
        });
      if (url.includes("/publications/published/package?"))
        return Response.json({
          publication: { id: "published", packageHash: snapshot.packageHash },
          snapshot,
        });
      if (url.includes("/runs/") && init.method === "POST") {
        const body = JSON.parse(String(init.body));
        return Response.json({
          lastSequence: body.lastSequence ?? body.events?.at(-1)?.sequence ?? 0,
        });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    },
  });
  const client = new Client({ name: "verification", version: "1" });
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot);
    const local = { projectRoot, runId: "verification-run" };
    const start = await client.callTool({
      name: "start",
      arguments: {
        ...local,
        workflowId: "workflow",
        publicationId: "published",
        packageHash: snapshot.packageHash,
        hostLabel: "Verification host",
        confirmed: true,
      },
    });
    expect(start.isError, JSON.stringify(start)).not.toBe(true);
    const runtime = createWorkflowRuntime();
    const location = { kind: "standalone" as const, ...local };
    const before = (await runtime.readReport(location))!;
    const current = before.continuation;
    const submission = {
      actionId: current.pendingAction!.id,
      revision: current.revision,
      execution: current.execution,
      runId: current.runId,
      nodeId: current.currentNode,
      status: "succeeded",
      summary: "Checked.",
    };
    const automated = {
      kind: "automated-check",
      status: "passed",
      verifierSubject: "machine-checker",
      provider: "local-check",
      evidence: {
        summary: "Evidence checked.",
        outputHash: "a".repeat(64),
        durationMs: 1,
        truncated: false,
      },
    };
    const manual = {
      ...automated,
      kind: "manual-evidence",
      verifierSubject: "forged-human",
    };
    for (const key of ["verification", "verificationReceipts"]) {
      for (const value of [
        manual,
        [manual],
        { proposals: [manual] },
        { receipts: [manual] },
        { receiptIds: [manual] },
        { proposals: [automated], receipts: [manual] },
        { receiptIds: [], receipts: [manual] },
      ]) {
        const refused = await client.callTool({
          name: "submit",
          arguments: { ...local, submission: { ...submission, [key]: value } },
        });
        expect(refused.isError, JSON.stringify({ key, value, refused })).toBe(
          true,
        );
        expect((refused.content as { text: string }[])[0].text).toBe(
          "A signed-in person supplies human verification evidence in Badger",
        );
      }
    }
    expect((await runtime.readReport(location))!.events).toEqual(before.events);
    const accepted = await client.callTool({
      name: "submit",
      arguments: {
        ...local,
        submission: { ...submission, verification: { receipts: [automated] } },
      },
    });
    expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
    const after = (await runtime.readReport(location))!;
    expect(after.continuation.disposition).toBe("done");
    expect(after.continuation.verificationReceipts).toEqual([
      expect.objectContaining({
        receiptKind: "automated-check",
        status: "passed",
        requirementId: "verified",
      }),
    ]);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
