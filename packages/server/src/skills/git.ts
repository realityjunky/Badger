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

/**
 * Whether a file is attributes that, comments aside, assign the Git LFS
 * filter, or a Git LFS pointer, which stands in the tree for its file.
 */
function usesLfs(file: UploadFile): boolean {
  if (/(?:^|\/)\.gitattributes$/u.test(file.path))
    return file.content
      .toString("utf8")
      .split("\n")
      .some((line) => {
        const [pattern, ...assigned] = line.trim().split(/\s+/u);
        return !pattern?.startsWith("#") && assigned.includes("filter=lfs");
      });
  return (
    file.content.length < 1024 &&
    file.content
      .toString("latin1")
      .startsWith("version https://git-lfs.github.com/spec/v1\n")
  );
}

// Each fetch may download and store up to the repository byte limit for a
// request of a few hundred bytes, so a process runs only a few at once.
const MAX_CONCURRENT_FETCHES = 2;
let runningFetches = 0;

/** Refuses, rather than queues, a fetch beyond the concurrency limit. */
export async function fetchGitFiles(
  config: ServiceConfig,
  url: string,
  commit: string,
): Promise<{ files: UploadFile[]; ref: string }> {
  if (runningFetches >= MAX_CONCURRENT_FETCHES)
    throw new RequestError(
      503,
      `At most ${MAX_CONCURRENT_FETCHES} Git imports run at once; try again shortly`,
      undefined,
      // A running fetch has ended by then.
      Math.ceil(config.git.timeoutMs / 1000),
    );
  runningFetches += 1;
  try {
    return await fetchCommit(config, url, commit);
  } finally {
    runningFetches -= 1;
  }
}

/** Reads objects from a fresh bare repository; no checkout, hooks, or filters. */
async function fetchCommit(
  config: ServiceConfig,
  url: string,
  commit: string,
): Promise<{ files: UploadFile[]; ref: string }> {
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
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.proxy",
    GIT_CONFIG_VALUE_0: config.git.proxy ?? "",
    // The private smart-HTTP transport applies the proxy to the upstream.
    // Git's loopback hop must always reach that transport directly.
    NO_PROXY: ["127.0.0.1", config.git.noProxy].filter(Boolean).join(","),
    // Git inflates objects before ls-tree can report their expanded sizes.
    // Bound individual allocations too, including unpack/delta allocations.
    GIT_ALLOC_LIMIT: String(config.uploads.maxBytes + 16 * 1024 * 1024),
  };
  // `refusal` explains a nonzero exit that no limit or timeout caused.
  const run = (
    args: string[],
    refusal: () => RequestError,
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
        () => stop(new RequestError(503, "Git import timed out")),
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
                    503,
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
        failure ??= new RequestError(503, "Git is unavailable on this server");
      });
      child.on("close", (code) => {
        finished = true;
        clearTimeout(timeout);
        clearInterval(monitor);
        if (failure !== undefined) reject(failure);
        else if (code !== 0) reject(refusal());
        else resolve(Buffer.concat(chunks));
      });
    });
  const failed = () => new RequestError(503, "Git failed on this server");
  const notCommit = () =>
    new RequestError(
      400,
      "The supplied hash must identify a commit, not a tag or tree",
    );
  const notPublished = () =>
    new RequestError(
      400,
      "This commit is refused: no published branch or tag reaches it in the registered repository",
    );
  let transport: Awaited<ReturnType<typeof openGitTransport>> | undefined;
  try {
    await run(
      [
        "init",
        "--bare",
        "--template=",
        ...(commit.length === 64 ? ["--object-format=sha256"] : []),
      ],
      failed,
    );
    const opened = await openGitTransport(config, url);
    transport = opened;
    // The transport's failure explains Git's exit: an unavailable host, an
    // answer that is not smart HTTP, or a limit. Otherwise the commit is
    // missing from what the host serves.
    await run(
      [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        opened.url,
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
      ],
      () => opened.failure() ?? notPublished(),
    );
    if ((await directoryBytes(workspace)) > config.git.maxRepositoryBytes)
      throw new RequestError(
        413,
        "Git repository exceeds the fetch size limit",
      );
    if (
      (await run(["cat-file", "-t", commit], notPublished))
        .toString("utf8")
        .trim() !== "commit"
    )
      throw notCommit();
    const resolved = (
      await run(["rev-parse", "--verify", `${commit}^{commit}`], notPublished)
    )
      .toString("utf8")
      .trim();
    if (resolved !== commit) throw notCommit();
    const containing = (
      await run(
        [
          "for-each-ref",
          `--contains=${commit}`,
          "--format=%(refname)",
          "refs/remotes/origin/",
          "refs/tags/",
        ],
        failed,
      )
    )
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    const published = containing[0];
    if (!published) throw notPublished();
    const ref = published.replace(/^refs\/remotes\/origin\//u, "refs/heads/");
    const tree = await run(
      ["ls-tree", "-r", "-l", "-z", "--full-tree", commit],
      failed,
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
      failed,
      config.uploads.maxBytes + entries.length * 128,
      entries.map((entry) => entry.hash + "\n").join(""),
    );
    let offset = 0;
    const files = entries.map((entry) => {
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
    // Git LFS commits pointers, which would import in place of their files.
    if (files.some(usesLfs))
      throw new RequestError(
        400,
        "This tree keeps files in Git LFS, which a Git import cannot fetch; upload the Skill folder instead",
      );
    return { files, ref };
  } finally {
    await transport?.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
