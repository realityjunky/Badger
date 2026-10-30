import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBadgerMcp } from "./index.js";
import type { BadgerHttpTransport } from "./api.js";
import {
  createPackageSnapshot,
  certificationExecFile,
  generatePackage,
  hashDirectory,
  normalizeWorkflow,
  type WorkflowInput,
  verifyPackageSnapshot,
  type PackageSnapshot,
  type WorkflowMcpCertificationEvidence,
} from "@realityjunky/badger";

// Node 22's ESM facade eagerly reads node:http's lazy WebSocket exports,
// loading Undici and its WebAssembly parser even for a named HTTP import.
// Read only the trusted HTTP functions through CommonJS under --jitless.
const { createServer, request: httpRequest } = createRequire(import.meta.url)(
  "node:http",
) as typeof import("node:http");

/** Trusted certification adapter. The loopback service speaks the production
 * HTTP contract with synthetic immutable bytes; every runtime action is an
 * actual public MCP SDK call. No domain script is invoked. */
export async function certifyBadgerMcp(options: {
  generatedPackageHash: string;
  snapshot?: PackageSnapshot;
}): Promise<WorkflowMcpCertificationEvidence> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-mcp-certification-"),
  );
  await fs.chmod(root, 0o700);
  const toolCalls: string[] = [];
  const evidence: WorkflowMcpCertificationEvidence = {
    authority: "BadgerMCP",
    mode: "mcp",
    generatedPackageHash: options.generatedPackageHash,
    toolCalls,
    evaluatedPackageStarted: false,
    completed: false,
    rootBindingRequired: false,
    refusedStartRegisteredNothing: false,
    receiptRootVerified: false,
    skippedNodeRefused: false,
    missingCompletionRefused: false,
    illegalRouteRefused: false,
    exhaustedCycleRefused: false,
  };
  const node = (id: string): WorkflowInput["customNodes"][number] => ({
    id,
    label: id,
    kind: "action",
    responsibility: `Run ${id}.`,
    implementation: {
      skill: `synthetic-${id}`,
      operation: "default",
      scope: "main",
    },
    operations: ["require", "augment", "disable"],
    outputSchemas: id === "produce" ? ["result.v1"] : [],
    guardrails: [],
  });
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "mcp-certification",
    goal: "Certify MCP execution without domain scripts.",
    customNodes: [node("produce"), node("finish")],
    outputSchemas: [
      {
        id: "result.v1",
        description: "Synthetic output.",
        externalRoots: {
          outputs: { description: "Where synthetic results are written." },
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
        evidence: [{ id: "checked", required: true }],
      },
    ],
    routing: {
      fields: [{ id: "next", values: ["repeat", "finish"] }],
      transitions: [
        {
          from: "produce",
          to: "produce",
          condition: "success",
          when: { field: "next", equals: "repeat" },
        },
        {
          from: "produce",
          to: "finish",
          condition: "success",
          when: { field: "next", equals: "finish" },
        },
        { from: "finish", to: null, condition: "success" },
      ],
    },
    cycles: [
      {
        key: "productions",
        entry: "produce",
        repeatTransitions: [{ from: "produce", to: "produce" }],
        maxInstances: 1,
      },
    ],
  };
  const protocol = normalizeWorkflow(input).protocol;
  const generated = await generatePackage({
    proposal: {
      schemaVersion: 1,
      name: protocol.name,
      goal: protocol.goal,
      intent: "new-skill",
      planHash: "mcp-certification-plan",
      proposalHash: "mcp-certification-proposal",
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
  const snapshot = await createPackageSnapshot(
    generated.packageRoot,
    generated.inventory,
  );
  const evaluated = options.snapshot
    ? verifyPackageSnapshot(options.snapshot)
    : snapshot;
  if (
    options.snapshot &&
    evaluated.packageHash !== options.generatedPackageHash
  )
    throw new Error("Evaluated MCP package hash mismatch");
  const registered = new Map<
    string,
    { events: unknown[]; projection?: unknown }
  >();
  const service = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const route = url.pathname.replace(/^\/api\/v1/u, "");
    let value: unknown = {};
    let status = 200;
    try {
      if (
        request.headers.authorization !== "Bearer synthetic-certification-token"
      )
        throw new Error("Unexpected certification credential");
      if (route === "/me/mcp")
        value = { capabilities: { operateRuns: true, installPublished: true } };
      else if (route === "/me") value = { person: { id: "synthetic-person" } };
      else if (route === "/workflows/synthetic/publications/published/package")
        value = {
          publication: { id: "published", packageHash: snapshot.packageHash },
          snapshot,
        };
      else if (route === "/workflows/evaluated/publications/published/package")
        value = {
          publication: { id: "published", packageHash: evaluated.packageHash },
          snapshot: evaluated,
        };
      else if (
        route === "/workflows/synthetic/runs/access" ||
        route === "/workflows/evaluated/runs/access"
      )
        value = {
          personId: "synthetic-person",
          agentHost: "MCP certification",
        };
      else if (route === "/me/runs")
        value = {
          runs: [...registered.entries()].map(([id, run]) => ({ id, ...run })),
        };
      else if (route.startsWith("/runs/") && request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const id = route.split("/")[2];
        const run = registered.get(id) ?? { events: [] };
        if (route.endsWith("/events")) {
          for (const event of body.events) {
            const e = event as { sequence: number };
            if (e.sequence === run.events.length + 1) run.events.push(event);
            else if (
              JSON.stringify(run.events[e.sequence - 1]) !==
              JSON.stringify(event)
            )
              throw new Error("Out-of-order certification event");
          }
          if (body.projection) run.projection = body.projection;
          value = { lastSequence: run.events.length };
        } else value = { run: { id } };
        registered.set(id, run);
      } else {
        status = 404;
        value = { error: { message: "Unknown certification route" } };
      }
    } catch (error) {
      status = 400;
      value = {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const address = service.address();
  if (!address || typeof address === "string")
    throw new Error("Missing certification service address");
  const transport: BadgerHttpTransport = async (url, init) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        String(url),
        {
          method: init?.method,
          headers: init?.headers as Record<string, string>,
          signal: init?.signal ?? undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024 * 1024)
              req.destroy(new Error("Certification HTTP response too large"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            const status = response.statusCode!;
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              status,
              ok: status >= 200 && status < 300,
              headers: {
                get(name) {
                  const value = response.headers[name.toLowerCase()];
                  return Array.isArray(value)
                    ? value.join(", ")
                    : (value ?? null);
                },
              },
              json: async () => JSON.parse(body) as unknown,
            });
          });
          response.on("error", reject);
        },
      );
      req.on("error", reject);
      if (init?.body) req.write(init.body);
      req.end();
    });
  const server = createBadgerMcp({
    fetch: transport,
    url: `http://127.0.0.1:${address.port}`,
    token: "synthetic-certification-token",
    agentHost: "MCP certification",
    profile: "operator",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "MCP certification", version: "1" });
  await server.connect(b);
  await client.connect(a);
  await client.listTools();
  async function call(name: string, args: Record<string, unknown> = {}) {
    toolCalls.push(name);
    const reply = await client.callTool({ name, arguments: args });
    let text = (reply.content as { text: string }[])[0].text;
    if (reply.isError) return { error: text };
    let value = JSON.parse(text);
    if (value.localFile) {
      const resource = (reply.content as { type: string; uri?: string }[]).find(
        (item) => item.type === "resource_link",
      );
      if (!resource || typeof resource.uri !== "string")
        throw new Error("Missing certification result resource");
      const read = await client.readResource({ uri: resource.uri });
      const content = read.contents[0];
      if (!("text" in content))
        throw new Error("Missing certification result text");
      value = JSON.parse(content.text);
    }
    return value;
  }
  try {
    const projectRoot = path.join(root, "project"),
      outputs = path.join(root, "outputs");
    await fs.mkdir(projectRoot);
    await fs.mkdir(outputs);
    const identity = {
      workflowId: "synthetic",
      publicationId: "published",
      packageHash: snapshot.packageHash,
    };
    const local = { projectRoot, runId: "mcp-run" };
    const requirements = await call("status", { ...identity, ...local });
    if (requirements.error)
      throw new Error(`MCP status refused: ${requirements.error}`);
    if (requirements.startRequirements.externalRoots[0]?.name !== "outputs")
      throw new Error("Missing runtime root requirements");
    const start = {
      ...identity,
      ...local,
      hostLabel: "Synthetic host",
      confirmed: true,
    };
    const refused = await call("start", start);
    evidence.rootBindingRequired =
      refused.error ===
      "Workflow artifact external root outputs needs a directory when the Run starts: Where synthetic results are written.";
    evidence.refusedStartRegisteredNothing =
      registered.size === 0 &&
      !(await fs.stat(path.join(projectRoot, ".badger/runs/mcp-run")).then(
        () => true,
        () => false,
      ));
    let current = (
      await call("start", { ...start, externalRoots: { outputs } })
    ).continuation;
    if (!current) throw new Error("MCP did not start the Run");
    current = (await call("next", local)).continuation;
    const submission = () => ({
      actionId: current.pendingAction.id,
      revision: current.revision,
      nodeId: current.currentNode,
      execution: current.execution,
      runId: current.runId,
      status: "succeeded",
      summary: "Synthetic output produced.",
      evidence: { checked: "Verified synthetic content." },
      routing: { next: "finish" },
    });
    const scriptRoot = path.join(root, "script-parity");
    async function script(args: string[]) {
      try {
        const result = await certificationExecFile(
          process.execPath,
          [
            path.join(generated.packageRoot, "scripts/workflow-state.mjs"),
            ...args,
            "--run-root",
            scriptRoot,
            "--json",
          ],
          {
            env: {
              PATH: process.env.PATH,
              ...(process.execArgv.includes("--jitless")
                ? { NODE_OPTIONS: "--jitless" }
                : {}),
            },
            timeout: 5000,
            maxBuffer: 1024 * 1024,
          },
        );
        return { continuation: JSON.parse(result.stdout) };
      } catch (error) {
        const stderr =
          (error as { stderr?: string }).stderr ??
          (error instanceof Error ? error.message : String(error));
        return {
          error: stderr
            .trim()
            .split("\n")
            .filter((line) => !line.startsWith("FINDING:"))
            .at(-1),
        };
      }
    }
    const scriptStarted = await script([
      "init",
      "--run-id",
      "script-parity",
      "--external-root",
      `outputs=${outputs}`,
    ]);
    if (!scriptStarted.continuation)
      throw new Error(scriptStarted.error ?? "Script parity Run did not start");
    const skip = await call("submit", {
      ...local,
      submission: { ...submission(), nodeId: "finish" },
    });
    const scriptSkip = await script([
      "record",
      "finish",
      JSON.stringify({ summary: "Wrong Node." }),
    ]);
    evidence.skippedNodeRefused =
      typeof skip.error === "string" && skip.error === scriptSkip.error;
    const missing = await call("submit", {
      ...local,
      submission: submission(),
    });
    const scriptMissing = await script([
      "record",
      "produce",
      JSON.stringify({
        summary: "Missing output.",
        "result.v1.checked": "Checked.",
        routing: { next: "finish" },
      }),
    ]);
    evidence.missingCompletionRefused =
      missing.continuation?.disposition === "blocked" &&
      JSON.stringify(missing.continuation.blockers) ===
        JSON.stringify(scriptMissing.continuation?.blockers);
    await fs.writeFile(
      path.join(outputs, "result.bin"),
      "Synthetic MCP receipt output.\n",
    );
    const missingEvidence = await call("submit", {
      ...local,
      submission: { ...submission(), evidence: {} },
    });
    const scriptMissingEvidence = await script([
      "record",
      "produce",
      JSON.stringify({
        summary: "Completion evidence missing.",
        routing: { next: "finish" },
      }),
    ]);
    evidence.missingCompletionRefused &&=
      missingEvidence.continuation?.disposition === "blocked" &&
      JSON.stringify(missingEvidence.continuation.blockers) ===
        JSON.stringify(scriptMissingEvidence.continuation?.blockers);
    const illegal = await call("submit", {
      ...local,
      submission: { ...submission(), routing: { next: "unlisted" } },
    });
    const scriptIllegal = await script([
      "record",
      "produce",
      JSON.stringify({
        summary: "Illegal route.",
        "result.v1.checked": "Checked.",
        routing: { next: "unlisted" },
      }),
    ]);
    evidence.illegalRouteRefused =
      illegal.continuation?.disposition === "blocked"
        ? JSON.stringify(illegal.continuation.blockers) ===
          JSON.stringify(scriptIllegal.continuation?.blockers)
        : typeof illegal.error === "string" &&
          illegal.error === scriptIllegal.error;
    const exhausted = await call("submit", {
      ...local,
      submission: { ...submission(), routing: { next: "repeat" } },
    });
    const scriptExhausted = await script([
      "record",
      "produce",
      JSON.stringify({
        summary: "Exhausted Cycle.",
        "result.v1.checked": "Checked.",
        routing: { next: "repeat" },
      }),
    ]);
    evidence.exhaustedCycleRefused =
      exhausted.continuation?.disposition === "blocked"
        ? JSON.stringify(exhausted.continuation.blockers) ===
          JSON.stringify(scriptExhausted.continuation?.blockers)
        : typeof exhausted.error === "string" &&
          exhausted.error === scriptExhausted.error;
    current = (await call("submit", { ...local, submission: submission() }))
      .continuation;
    evidence.receiptRootVerified = current?.visits.some((v: any) =>
      v.outcomes.some((o: any) =>
        o.evidence?.artifactReceipts?.some(
          (receipt: any) =>
            receipt.root?.name === "outputs" &&
            receipt.root.path === outputs &&
            receipt.producer.attemptId,
        ),
      ),
    );
    current = (await call("recover", local)).continuation;
    const done = await call("submit", {
      ...local,
      submission: { ...submission(), routing: undefined },
    });
    evidence.completed = done.continuation?.disposition === "done";
    await call("status", local);
    await call("my_runs");
    const selected = {
      projectRoot,
      runId: "evaluated-package",
      workflowId: "evaluated",
      publicationId: "published",
      packageHash: evaluated.packageHash,
    };
    const selectedRequirements = await call("status", selected);
    if (selectedRequirements.error) throw new Error(selectedRequirements.error);
    const externalRoots: Record<string, string> = {};
    for (const [
      i,
      requirement,
    ] of selectedRequirements.startRequirements.externalRoots.entries()) {
      const directory = path.join(root, `evaluated-root-${i}`);
      await fs.mkdir(directory);
      externalRoots[requirement.name] = directory;
    }
    const selectedRun = await call("start", {
      ...selected,
      hostLabel: "Selected package certification",
      confirmed: true,
      externalRoots,
    });
    evidence.evaluatedPackageStarted = Boolean(
      selectedRun.continuation?.execution,
    );
    if (!evidence.evaluatedPackageStarted)
      throw new Error(
        selectedRun.error ?? "Selected package did not start through MCP",
      );
    await call("recover", { projectRoot, runId: selected.runId });
    await client.listTools();
    await client.listResources();
    if ((await hashDirectory(generated.packageRoot)) !== snapshot.packageHash)
      throw new Error("Certification modified package bytes");
    return evidence;
  } finally {
    await client.close();
    await server.close();
    await new Promise<void>((resolve, reject) =>
      service.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const evidence = await certifyBadgerMcp({
      generatedPackageHash: process.argv[2] ?? "",
      ...(process.argv[3]
        ? { snapshot: JSON.parse(await fs.readFile(process.argv[3], "utf8")) }
        : {}),
    });
    process.stdout.write(JSON.stringify(evidence) + "\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "MCP certification failed"}\n`,
    );
    process.exitCode = 1;
  }
}
