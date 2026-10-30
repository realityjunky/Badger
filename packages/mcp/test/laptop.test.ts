import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  commitHostPlan,
  downloadPublishedPackage,
  previewInstall,
} from "@realityjunky/badger-hosts";
import { createWorkflowRuntime } from "@realityjunky/badger/workflow-runtime";
import { startPlanningService } from "../../server/test/fixtures/planning.js";
import {
  operator,
  publishedFixture,
  receiptPlan,
} from "../../server/test/fixtures/runs.js";

let service: Awaited<ReturnType<typeof startPlanningService>> | undefined;
let client: Client | undefined;
let folder: string | undefined;
afterEach(async () => {
  await client?.close();
  await service?.close();
  if (folder) await fs.rm(folder, { recursive: true, force: true });
});

it.skipIf(process.platform !== "linux")(
  "runs the installer-written WorkBuddy stdio entry with spaced Unicode paths, enforces Completion and mirrors the exact committed report",
  async () => {
    service = await startPlanningService();
    const f = await publishedFixture(service, receiptPlan);
    // macOS's system temporary directory can itself be reached through a symlink.
    folder = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "badger-laptop-")),
    );
    const projectRoot = path.join(folder, "Work space 运行");
    const homeRoot = path.join(folder, "Home space");
    const outputs = path.join(folder, "Report outputs 输出");
    await Promise.all([projectRoot, homeRoot, outputs].map((p) => fs.mkdir(p)));
    const identity = {
      workflowId: f.workflow.id,
      publicationId: f.publication.id,
      packageHash: f.publication.packageHash,
    };
    const snapshot = await downloadPublishedPackage(
      { url: service.baseUrl, token: f.operatorToken },
      identity,
    );
    const plan = await previewInstall({
      target: { host: "workbuddy", scope: "project", projectRoot, homeRoot },
      publication: identity,
      snapshot,
      deploymentUrl: service.baseUrl,
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/src/cli.js", import.meta.url))],
    });
    await commitHostPlan(plan, {
      confirmed: true,
      digest: plan.preview.digest,
    });
    const configuration = await fs.readFile(
      path.join(projectRoot, ".mcp.json"),
      "utf8",
    );
    expect(configuration).not.toContain(f.operatorToken);
    const entry = JSON.parse(configuration).mcpServers.badger;
    expect(entry.env.BADGER_TOKEN).toBe("${BADGER_TOKEN}");
    client = new Client({
      name: "WorkBuddy protocol fixture",
      version: "1.0.0",
    });
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        cwd: projectRoot,
        // Emulate the documented expansion; actual app expansion is a manual check.
        env: {
          ...entry.env,
          BADGER_TOKEN: f.operatorToken,
          BADGER_AGENT_HOST: "WorkBuddy",
        },
      }),
    );
    const connection = client;
    let resourceRead = false;
    async function value(name: string, args: Record<string, unknown> = {}) {
      const reply = await connection.callTool({ name, arguments: args });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const text = reply.content as {
        type: string;
        text?: string;
        uri?: string;
      }[];
      let result = JSON.parse(text[0].text!);
      if (result.localFile) {
        const resource = text.find((item) => item.type === "resource_link")!;
        const read = await connection.readResource({ uri: resource.uri! });
        const content = read.contents[0];
        if (!("text" in content))
          throw new Error("Expected a text result resource");
        result = JSON.parse(content.text);
        expect(
          JSON.parse(
            await fs.readFile(JSON.parse(text[0].text!).localFile, "utf8"),
          ),
        ).toEqual(result);
        resourceRead = true;
      }
      return result;
    }
    expect((await value("whoami")).credential).toMatchObject({
      kind: "token",
      scopes: ["operator"],
    });
    const local = { projectRoot, runId: "laptop-run" };
    const requirements = await value("status", { ...identity, ...local });
    expect(requirements.startRequirements.externalRoots).toMatchObject([
      { name: "outputs" },
    ]);
    const start = {
      ...identity,
      ...local,
      hostLabel: "Laptop protocol check",
      confirmed: true,
    };
    expect(
      (await connection.callTool({ name: "start", arguments: start })).isError,
    ).toBe(true);
    expect((await value("my_runs")).runs).toEqual([]);
    await value("start", { ...start, externalRoots: { outputs } });
    let current = (await value("next", local)).continuation;
    const submission = () => ({
      actionId: current.pendingAction.id,
      revision: current.revision,
      runId: current.runId,
      nodeId: current.currentNode,
      execution: current.execution,
      status: "succeeded",
      summary: "Synthetic laptop report. ".repeat(400),
      evidence: { summary: "Reviewed the synthetic report." },
    });
    expect(
      (
        await connection.callTool({
          name: "submit",
          arguments: {
            ...local,
            submission: { ...submission(), nodeId: "skipped-node" },
          },
        })
      ).isError,
    ).toBe(true);
    const missing = await value("submit", {
      ...local,
      submission: submission(),
    });
    expect(missing.continuation.disposition).toBe("blocked");
    expect(missing.continuation.blockers.join("; ")).toContain(
      "Missing Output Schema artifacts",
    );
    await fs.writeFile(
      path.join(outputs, "result.bin"),
      "Synthetic laptop report.\n",
    );
    current = (await value("next", local)).continuation;
    const done = await value("submit", { ...local, submission: submission() });
    expect(done.continuation.disposition).toBe("done");
    await expect
      .poll(
        async () => {
          const { runs } = await value("my_runs");
          return runs[0]?.projection?.status;
        },
        { timeout: 10_000 },
      )
      .toBe("completed");
    const { runs } = await value("my_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      ...identity,
      hostLabel: "Laptop protocol check",
      agentHost: "WorkBuddy",
    });
    const detail = await f.call(
      `/runs/${runs[0].id}`,
      "GET",
      undefined,
      operator,
    );
    const report = (await createWorkflowRuntime().readReport({
      kind: "standalone",
      ...local,
    }))!;
    expect(detail.run.events).toEqual(report.events);
    expect(detail.run.projection).toEqual(report.projection);
    expect(
      detail.run.projection.visits[0].outcomes[0].evidence.artifactReceipts,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ root: { name: "outputs", path: outputs } }),
      ]),
    );
    expect(resourceRead).toBe(true);
  },
  90_000,
);
