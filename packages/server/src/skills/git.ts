import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServiceConfig } from "../config.js";
import { RequestError } from "../http/errors.js";
import { openGitTransport } from "./git-transport.js";
import { MAX_PATH_BYTES, type UploadFile } from "./paths.js";

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    try {
      bytes += entry.isDirectory()
        ? await directoryBytes(target)
        : (await fs.lstat(target)).size;
    } catch (error) {
      // Git atomically renames temporary pack files while the monitor walks.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return bytes;
}

/** Reads objects from a fresh bare repository; no checkout, hooks, or filters. */
export async function fetchGitFiles(
  config: ServiceConfig,
  url: string,
  commit: string,
): Promise<UploadFile[]> {
  const workspace = await fs.mkdtemp(
    path.join(config.storage.workspaceDirectory, "skill-git-"),
  );
  const deadline = Date.now() + config.git.timeoutMs;
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    SystemRoot: process.env["SystemRoot"],
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    // Git inflates objects before ls-tree can report their expanded sizes.
    // Bound individual allocations too, including unpack/delta allocations.
    GIT_ALLOC_LIMIT: String(config.uploads.maxBytes + 16 * 1024 * 1024),
  };
  const run = (
    args: string[],
    maxBytes = 4096,
    input?: string,
  ): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          `core.hooksPath=${path.join(workspace, "disabled-hooks")}`,
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "protocol.http.allow=always",
          "-c",
          "http.followRedirects=false",
          "-c",
          "fetch.fsckObjects=true",
          "-c",
          "transfer.fsckObjects=true",
          "-c",
          "pack.threads=1",
          "-c",
          `core.deltaBaseCacheLimit=${config.uploads.maxBytes}`,
          "-c",
          "fetch.unpackLimit=1",
          "-C",
          workspace,
          ...args,
        ],
        {
          env: environment,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      let finished = false;
      let checking = false;
      const stop = (error: Error) => {
        failure ??= error;
        if (child.pid !== undefined && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        } else child.kill("SIGKILL");
      };
      const timeout = setTimeout(
        () => stop(new RequestError(400, "Git import timed out")),
        Math.max(1, deadline - Date.now()),
      );
      const monitor = setInterval(() => {
        if (checking || finished) return;
        checking = true;
        void directoryBytes(workspace)
          .then(
            (size) => {
              if (!finished && size > config.git.maxRepositoryBytes)
                stop(
                  new RequestError(
                    413,
                    "Git repository exceeds the fetch size limit",
                  ),
                );
            },
            () => {
              if (!finished)
                stop(
                  new RequestError(
                    400,
                    "Could not inspect the fetched repository",
                  ),
                );
            },
          )
          .finally(() => {
            checking = false;
          });
      }, 50);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes)
          stop(
            new RequestError(413, "Git tree exceeds the file or byte limit"),
          );
        else chunks.push(chunk);
      });
      // Recognize only Git's allocation guard. Diagnostics remain private,
      // bounded, and are never returned or logged, even on a remote failure.
      let diagnosticTail = "";
      child.stderr.on("data", (chunk: Buffer) => {
        diagnosticTail = (diagnosticTail + chunk.toString("utf8")).slice(-4096);
        if (
          /fatal: attempting to allocate [0-9]+ over limit [0-9]+/u.test(
            diagnosticTail,
          )
        )
          stop(
            new RequestError(413, "Git objects exceed the allocation limit"),
          );
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
      child.on("error", () => {
        failure ??= new RequestError(400, "Git is unavailable on this server");
      });
      child.on("close", (code) => {
        finished = true;
        clearTimeout(timeout);
        clearInterval(monitor);
        if (failure !== undefined) reject(failure);
        else if (code !== 0)
          reject(
            new RequestError(
              400,
              "The registered repository could not supply that commit",
            ),
          );
        else resolve(Buffer.concat(chunks));
      });
    });
  let transport: Awaited<ReturnType<typeof openGitTransport>> | undefined;
  try {
    await run([
      "init",
      "--bare",
      "--template=",
      ...(commit.length === 64 ? ["--object-format=sha256"] : []),
    ]);
    transport = await openGitTransport(config, url);
    try {
      await run([
        "fetch",
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        transport.url,
        commit,
      ]);
    } catch (error) {
      throw transport.failure() ?? error;
    }
    if ((await directoryBytes(workspace)) > config.git.maxRepositoryBytes)
      throw new RequestError(
        413,
        "Git repository exceeds the fetch size limit",
      );
    const resolved = (
      await run(["rev-parse", "--verify", `${commit}^{commit}`])
    )
      .toString("utf8")
      .trim();
    if (resolved !== commit)
      throw new RequestError(
        400,
        "The supplied hash must identify a commit, not a tag or tree",
      );
    const tree = await run(
      ["ls-tree", "-r", "-l", "-z", "--full-tree", commit],
      config.uploads.maxFiles * (MAX_PATH_BYTES + 128),
    );
    let names: string;
    try {
      names = new TextDecoder("utf-8", { fatal: true }).decode(tree);
    } catch {
      throw new RequestError(400, "Git file names must be UTF-8");
    }
    const entries = names
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const match = /^(\d+) (\w+) ([a-f0-9]+) +([0-9-]+)\t([\s\S]+)$/u.exec(
          entry,
        );
        if (
          match === null ||
          !["100644", "100755"].includes(match[1]!) ||
          match[2] !== "blob"
        )
          throw new RequestError(
            400,
            "Git sources may contain only regular files; links and submodules are refused",
          );
        return { hash: match[3]!, bytes: Number(match[4]), path: match[5]! };
      });
    if (
      entries.length === 0 ||
      entries.length > config.uploads.maxFiles ||
      entries.some((file) => file.bytes > config.uploads.maxFileBytes) ||
      entries.reduce((sum, file) => sum + file.bytes, 0) >
        config.uploads.maxBytes
    )
      throw new RequestError(
        413,
        "Git tree exceeds the file count or byte limit",
      );
    const blobs = await run(
      ["cat-file", "--batch"],
      config.uploads.maxBytes + entries.length * 128,
      entries.map((entry) => entry.hash + "\n").join(""),
    );
    let offset = 0;
    return entries.map((entry) => {
      const end = blobs.indexOf(10, offset);
      const header = blobs.subarray(offset, end).toString("ascii");
      if (
        end < 0 ||
        header !== `${entry.hash} blob ${entry.bytes}` ||
        blobs[end + 1 + entry.bytes] !== 10
      )
        throw new RequestError(400, "The fetched Git objects are incomplete");
      offset = end + 1;
      const content = blobs.subarray(offset, offset + entry.bytes);
      offset += entry.bytes + 1;
      return { path: entry.path, content };
    });
  } finally {
    await transport?.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
