import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { normalizeWorkflow } from "../src/index.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";

it.each([false, true])(
  "protects a claim owner's trajectory without mutation locks (owner killed: %s)",
  async (killOwner) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-concurrent-submit-"),
    );
    const runtime = createWorkflowRuntime();
    const protocol = normalizeWorkflow({
      kind: "workflow-kernel",
      name: "concurrent-submit",
      goal: "Preserve committed events.",
      customNodes: ["prepare", "finish"].map((id) => ({
        id,
        label: id,
        kind: "action",
        responsibility: `Run ${id}.`,
        implementation: {
          skill: `${id}-skill`,
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      })),
      capabilities: {
        version: 3,
        features: ["conditional-routing", "revisioned-attempts"],
      },
    }).protocol;
    const started = await runtime.start({
      protocol,
      runRoot: root,
      runId: "concurrent",
    });
    const submission = {
      actionId: started.pendingAction!.id,
      runId: started.runId,
      revision: started.revision,
      execution: started.execution,
      nodeId: started.currentNode,
      status: "succeeded" as const,
      summary: "Claim owner.",
    };
    const initial = (await runtime.readReport(root))!;
    const runtimeUrl = pathToFileURL(
      path.resolve("dist/src/workflow-runtime/public.js"),
    ).href;
    const code = `
    import { promises as fs } from "node:fs";
    import path from "node:path";
    const { createWorkflowRuntime } = await import(${JSON.stringify(runtimeUrl)});
    const root = process.argv[1];
    const submission = JSON.parse(process.argv[2]);
    const rename = fs.rename;
    let armed = true;
    fs.rename = async (from, to) => {
      if (armed && String(to).endsWith(path.sep + "trajectory.jsonl")) {
        armed = false;
        process.send("paused");
        await new Promise((resolve) => process.once("message", resolve));
      }
      return rename(from, to);
    };
    try {
      const current = await createWorkflowRuntime().submit(root, submission);
      process.send({ disposition: current.disposition, currentNode: current.currentNode });
    } finally { process.disconnect(); }
  `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", code, root, JSON.stringify(submission)],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    try {
      expect((await once(child, "message"))[0], errors).toBe("paused");
      const competing = await runtime.submit(root, {
        ...submission,
        summary: "Competing submission.",
      });
      expect(competing.findings).toContainEqual(
        expect.objectContaining({ code: "revision-conflict" }),
      );
      expect((await runtime.readReport(root))!.events).toEqual(initial.events);
      if (killOwner) {
        child.kill("SIGKILL");
        await exited;
        const claimDirectory = path.join(root, ".badger/revision-claims");
        const claimFile = path.join(
          claimDirectory,
          (await fs.readdir(claimDirectory))[0]!,
        );
        const claim = JSON.parse(await fs.readFile(claimFile, "utf8"));
        for (const ownerHostId of ["0".repeat(64), null, undefined]) {
          await fs.writeFile(
            claimFile,
            JSON.stringify({ ...claim, ownerHostId }),
          );
          await runtime.recover(root);
          expect((await fs.stat(claimFile)).isFile()).toBe(true);
        }
        await fs.writeFile(claimFile, JSON.stringify(claim));
        await runtime.recover(root);
        expect(
          (
            await runtime.submit(root, {
              ...submission,
              summary: "Recovered submission.",
            })
          ).currentNode,
        ).toBe("finish");
      } else {
        const completed = once(child, "message");
        child.send("continue");
        expect((await completed)[0], errors).toMatchObject({
          currentNode: "finish",
        });
        expect((await exited)[0], errors).toBe(0);
      }
      const report = (await runtime.readReport(root))!;
      const outcomes = report.events.filter(
        (event) => event.type === "action_completed",
      );
      expect(outcomes).toHaveLength(1);
      expect((outcomes[0]!.data.outcome as { summary: string }).summary).toBe(
        killOwner ? "Recovered submission." : "Claim owner.",
      );
      expect(report.events.map((event) => event.sequence)).toEqual(
        report.events.map((_, i) => i + 1),
      );
      expect(report.continuation.currentNode).toBe("finish");
    } finally {
      child.kill();
      await exited;
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
