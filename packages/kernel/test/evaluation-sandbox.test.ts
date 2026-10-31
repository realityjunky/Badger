import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluatePackage,
  generatePackage,
  normalizeWorkflow,
  type CreatorState,
} from "../src/index.js";

// Marks the detached descendants these tests start, so cleanup never signals
// a process that merely reused one's PID.
const DESCENDANT = "badger-evaluation-sandbox-test-descendant";
const roots: string[] = [];
const descendantPidFiles: string[] = [];
afterEach(async () => {
  for (const file of descendantPidFiles.splice(0)) {
    const pid = Number(await fs.readFile(file, "utf8").catch(() => ""));
    const command = await fs
      .readFile(`/proc/${pid}/cmdline`, "utf8")
      .catch(() => "");
    if (!command.includes(DESCENDANT)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
/** An adapter that leaves a detached descendant holding its stdout and stderr open for a minute. */
function detachedDescendantAdapter(pidFile: string, then: string) {
  descendantPidFiles.push(pidFile);
  return `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000); // ${DESCENDANT}'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });\nwriteFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));\ndescendant.unref();\n${then}\n`;
}
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-evaluation-sandbox-test-"),
  );
  roots.push(root);
  const workflow = {
    kind: "workflow-kernel" as const,
    name: "sandbox-evaluation",
    goal: "Certify deterministic adapters only.",
    customNodes: [
      {
        id: "report",
        label: "Report",
        kind: "action" as const,
        responsibility: "Prepare a report.",
        implementation: {
          skill: "reporter",
          operation: "default" as const,
          scope: "main",
        },
        operations: ["require" as const],
        outputSchemas: [],
        guardrails: [],
      },
    ],
  };
  const protocol = normalizeWorkflow(workflow).protocol;
  const generated = await generatePackage({
    projectRoot: root,
    destination: path.join(root, "generated"),
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
      planHash: "sandbox-plan",
      proposalHash: "sandbox-proposal",
      workflow: protocol,
      candidates: [],
      blockers: [],
      warnings: [],
      canInitialize: true,
    },
  });
  const state: CreatorState = {
    schemaVersion: 1,
    name: workflow.name,
    status: "generated",
    projectRoot: root,
    planPath: path.join(root, "plan.json"),
    planHash: "sandbox-plan",
    draftPath: generated.packageRoot,
    currentHash: null,
    candidates: [],
    generated,
  };
  return {
    root,
    state,
    script: path.join(generated.packageRoot, "scripts", "workflow-state.mjs"),
    options: {
      persistState: false,
      reportPath: path.join(root, "report.json"),
      sandbox: {
        tempDirectory: path.join(root, "private"),
        timeLimitMilliseconds: 60_000,
        childTimeLimitMilliseconds: 300,
        memoryLimitBytes: 128 * 1024 * 1024,
        outputLimitBytes: 4 * 1024 * 1024,
      },
    },
  };
}

it("enforces the adapter wall-time limit and retains a failing public evaluation report", async () => {
  const { state, script, options } = await fixture();
  await fs.writeFile(script, "setTimeout(() => process.exit(1), 1500);\n");
  const report = await evaluatePackage(state, options);
  expect(report.passed).toBe(false);
  expect(
    report.checks.find((check) => check.id === "workflow-runtime-certification")
      ?.detail,
  ).toContain("time limit");
}, 30_000);

it("accounts for native Buffer memory in adapter descendants and kills the process tree", async () => {
  const { root, state, script, options } = await fixture();
  options.sandbox.childTimeLimitMilliseconds = 2500;
  const childPid = path.join(root, "descendant.pid");
  await fs.writeFile(
    script,
    `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst held = Buffer.alloc(32 * 1024 * 1024, 1);\nconst child = spawn(process.execPath, ['-e', 'const bytes = Buffer.alloc(64 * 1024 * 1024, 1); setTimeout(() => console.log(bytes.length), 1800);']);\nwriteFileSync(${JSON.stringify(childPid)}, String(child.pid));\nsetTimeout(() => { console.log(held.length); process.exit(1); }, 2000);\n`,
  );
  const report = await evaluatePackage(state, options);
  expect(
    report.checks.find((check) => check.id === "workflow-runtime-certification")
      ?.detail,
  ).toContain("memory limit");
  const pid = await fs.readFile(childPid, "utf8");
  const status = await fs
    .readFile(`/proc/${pid}/status`, "utf8")
    .catch(() => "");
  expect(status === "" || /^State:\s+Z/mu.test(status)).toBe(true);
}, 30_000);

it("fails promptly when an adapter exits while a detached descendant keeps its output open", async () => {
  const { root, state, script, options } = await fixture();
  options.sandbox.childTimeLimitMilliseconds = 5000;
  // The adapter itself succeeds; only the descendant holds the pipes.
  await fs.writeFile(
    script,
    detachedDescendantAdapter(path.join(root, "descendant.pid"), ""),
  );
  const started = Date.now();
  const report = await evaluatePackage(state, options);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(report.passed).toBe(false);
  expect(
    report.checks.find((check) => check.id === "workflow-runtime-certification")
      ?.detail,
  ).toContain("a descendant kept its output open");
}, 30_000);

it("kills a detached descendant still reachable from an adapter it stops", async () => {
  const { root, state, script, options } = await fixture();
  options.sandbox.childTimeLimitMilliseconds = 2500;
  const descendantPid = path.join(root, "descendant.pid");
  await fs.writeFile(
    script,
    detachedDescendantAdapter(descendantPid, "setTimeout(() => {}, 60000);"),
  );
  const started = Date.now();
  const report = await evaluatePackage(state, options);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(
    report.checks.find((check) => check.id === "workflow-runtime-certification")
      ?.detail,
  ).toContain("time limit");
  const pid = await fs.readFile(descendantPid, "utf8");
  const status = await fs
    .readFile(`/proc/${pid}/status`, "utf8")
    .catch(() => "");
  expect(status === "" || /^State:\s+Z/mu.test(status)).toBe(true);
}, 30_000);

it("scrubs worker secrets and gives adapters private temporary storage without executing domain scripts or writing Creator state", async () => {
  const { root, state, script, options } = await fixture();
  options.sandbox.childTimeLimitMilliseconds = 15000;
  const observed = path.join(root, "environment.json");
  const marker = path.join(root, "domain-executed");
  await fs.mkdir(path.join(state.generated!.packageRoot, "domain"));
  await fs.writeFile(
    path.join(state.generated!.packageRoot, "domain", "never-run.mjs"),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad');`,
  );
  const original = await fs.readFile(script, "utf8");
  await fs.writeFile(
    script,
    `import { writeFileSync as capture, statSync as inspect } from 'node:fs';\ncapture(${JSON.stringify(observed)}, JSON.stringify({ secret: process.env.BADGER_EVALUATION_TEST_SECRET ?? null, home: process.env.HOME, temp: process.env.TMPDIR, mode: inspect(process.env.TMPDIR).mode & 0o777 }));\n${original.replace(/^#![^\n]*\n/u, "")}`,
  );
  process.env.BADGER_EVALUATION_TEST_SECRET = "worker-secret-must-stay-private";
  try {
    await evaluatePackage(state, options);
    const environment = JSON.parse(await fs.readFile(observed, "utf8"));
    expect(environment).toMatchObject({ secret: null, mode: 0o700 });
    expect(environment.temp).toContain(
      options.sandbox.tempDirectory + path.sep,
    );
    expect(environment.home).toBe(environment.temp);
    expect(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await fs
        .stat(path.join(root, ".badger", "states", `${state.name}.json`))
        .then(
          () => true,
          () => false,
        ),
    ).toBe(false);
  } finally {
    delete process.env.BADGER_EVALUATION_TEST_SECRET;
  }
}, 30_000);
