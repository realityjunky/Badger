import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export interface EvaluationSandbox {
  tempDirectory: string;
  timeLimitMilliseconds: number;
  childTimeLimitMilliseconds: number;
  memoryLimitBytes: number;
  outputLimitBytes: number;
}
interface Context {
  sandbox?: EvaluationSandbox;
  deadline: number;
  onProgress?: (phase: string) => void | Promise<void>;
}
const context = new AsyncLocalStorage<Context>();
const ordinaryExecFile = promisify(execFile);
export async function withCertificationContext<T>(
  sandbox: EvaluationSandbox | undefined,
  onProgress: Context["onProgress"],
  action: () => Promise<T>,
): Promise<T> {
  if (sandbox) {
    if (process.platform !== "linux")
      throw new Error(
        "Evaluation sandbox requires Linux process-tree memory accounting",
      );
    if (
      !path.isAbsolute(sandbox.tempDirectory) ||
      !Object.entries(sandbox).every(
        ([key, value]) =>
          key === "tempDirectory" ||
          (Number.isSafeInteger(value) && Number(value) > 0),
      )
    )
      throw new Error(
        "Evaluation sandbox requires an absolute temp directory and positive limits",
      );
    await fs.access("/usr/bin/prlimit");
    await fs.mkdir(sandbox.tempDirectory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(sandbox.tempDirectory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Evaluation temp directory must be a private directory");
    await fs.chmod(sandbox.tempDirectory, 0o700);
  }
  return context.run(
    {
      sandbox,
      deadline: Date.now() + (sandbox?.timeLimitMilliseconds ?? Infinity),
      onProgress,
    },
    action,
  );
}
export const certificationTemporaryDirectory = () =>
  context.getStore()?.sandbox?.tempDirectory ?? os.tmpdir();
export const certificationProgress = async (phase: string) => {
  await context.getStore()?.onProgress?.(phase);
};

/** Every actual adapter/fresh-process certification child goes through this boundary. */
export async function certificationExecFile(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const active = context.getStore();
  const limits = active?.sandbox;
  if (!limits) return ordinaryExecFile(file, args, options);
  const remaining = active!.deadline - Date.now();
  if (remaining <= 0)
    throw new Error("Evaluation exceeded its total time limit");
  const temporary = await fs.mkdtemp(path.join(limits.tempDirectory, "child-"));
  await fs.chmod(temporary, 0o700);
  try {
    return await new Promise((resolve, reject) => {
      if (file !== process.execPath) {
        reject(
          new Error("Certification sandbox only runs generated Node adapters"),
        );
        return;
      }
      // RLIMIT_DATA also bounds native allocations and is inherited by children.
      // JIT-less Node avoids V8 reserving a large executable CodeRange up front.
      const child = spawn(
        "/usr/bin/prlimit",
        [
          `--data=${limits.memoryLimitBytes}`,
          "--core=0",
          "--",
          file,
          "--jitless",
          ...args,
        ],
        {
          cwd: options.cwd,
          // Callers supply only PATH and explicit synthetic test inputs. No worker
          // credentials, NODE_OPTIONS, proxies, or caller HOME reach an adapter.
          env: {
            ...options.env,
            NODE_OPTIONS: "--jitless",
            HOME: temporary,
            TMPDIR: temporary,
            TMP: temporary,
            TEMP: temporary,
          },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "",
        bytes = 0;
      let failure: Error | undefined;
      let closed = false;
      const kill = (error?: Error) => {
        failure ??= error;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
      };
      const timer = setTimeout(
        () => kill(new Error("Certification child exceeded its time limit")),
        Math.min(
          remaining,
          limits.childTimeLimitMilliseconds,
          options.timeout ?? Infinity,
        ),
      );
      let sampling = false;
      const memory = setInterval(() => {
        if (sampling || !child.pid) return;
        sampling = true;
        residentTreeBytes(child.pid)
          .then(
            (bytes) => {
              if (!closed && bytes > limits.memoryLimitBytes)
                kill(
                  new Error(
                    `Certification child process tree exceeded its memory limit (${limits.memoryLimitBytes} bytes)`,
                  ),
                );
            },
            () => {
              if (!closed)
                kill(
                  new Error(
                    "Evaluation sandbox could not account for child memory",
                  ),
                );
            },
          )
          .finally(() => {
            sampling = false;
          });
      }, 10);
      const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (
          bytes >
          Math.min(limits.outputLimitBytes, options.maxBuffer ?? Infinity)
        )
          kill(new Error("Certification child exceeded its output limit"));
        else if (stream === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.once("error", (error) => {
        failure ??= error;
      });
      child.once("close", (code, signal) => {
        closed = true;
        clearTimeout(timer);
        clearInterval(memory);
        kill(); // A successful adapter must not leave descendants behind.
        if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new Error(
              `Certification child failed (${signal ?? code}): ${stderr.slice(0, 2048)}`,
            ),
          );
        else resolve({ stdout, stderr });
      });
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** A /proc file of the process, or null once the process is gone. */
const processFile = (pid: number, file: string) =>
  fs
    .readFile(`/proc/${pid}/${file}`, "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ESRCH") return null;
      throw error;
    });

/** Aggregate native and JS resident memory of the complete descendant tree. */
async function residentTreeBytes(
  pid: number,
  visited = new Set<number>(),
): Promise<number> {
  if (visited.has(pid)) return 0;
  visited.add(pid);
  const [status, children] = await Promise.all([
    processFile(pid, "status"),
    processFile(pid, `task/${pid}/children`),
  ]);
  // A process that still exists without a children file means the kernel
  // cannot list descendants: fail closed rather than count none. Only a
  // process that exited between the two reads has no children to count.
  if (
    status !== null &&
    children === null &&
    (await processFile(pid, "status")) !== null
  )
    throw new Error("The kernel does not list child processes");
  const own =
    Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status ?? "")?.[1] ?? 0) * 1024;
  const descendants = await Promise.all(
    (children ?? "")
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map((child) => residentTreeBytes(Number(child), visited)),
  );
  return own + descendants.reduce((sum, value) => sum + value, 0);
}
