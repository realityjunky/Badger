import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface StubGitRepositoryOptions {
  /** The repository's object names; SHA-256 needs Git 2.29 or later. */
  objectFormat?: "sha1" | "sha256";
  /**
   * The highest Git protocol version served. With 2, the default, as on
   * current hosts, a client that asks for version 2 gets it; with 0, every
   * client gets version 0.
   */
  protocol?: 0 | 2;
  /** Paths committed with the executable bit. */
  executable?: string[];
}

/** A real, read-only smart-HTTP Git remote; no service internals are replaced. */
export async function startStubGitRepository(
  files: Record<string, string>,
  options: StubGitRepositoryOptions = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-git-remote-"));
  const tree = path.join(root, "tree");
  await fs.mkdir(tree);
  // The remote's own Git ignores the host's configuration and environment,
  // including anything a test plants there for the service to ignore.
  const environment = {
    PATH: process.env["PATH"],
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
  };
  const git = (...args: string[]) =>
    exec("git", ["-C", tree, ...args], { env: environment });
  const commitFiles = async (changes: Record<string, string>) => {
    for (const [relative, content] of Object.entries(changes)) {
      const destination = path.join(tree, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }
    for (const relative of options.executable ?? [])
      if (relative in changes) await fs.chmod(path.join(tree, relative), 0o755);
    await git("add", ".");
    await git("commit", "--no-verify", "-m", "Skill fixture");
  };
  const requests: string[] = [];
  const protocols: number[] = [];
  let redirect: string | undefined;
  let stalled = false;
  let dumb = false;
  let failure: number | undefined;
  let held: (() => void)[] | undefined;
  let server: http.Server | undefined;
  try {
    await git(
      "init",
      "--template=",
      ...(options.objectFormat === "sha256" ? ["--object-format=sha256"] : []),
    );
    await git("config", "user.name", "Test author");
    await git("config", "user.email", "author@example.com");
    await commitFiles(files);
    const { stdout } = await git("rev-parse", "HEAD");
    await exec(
      "git",
      ["clone", "--bare", "--template=", tree, path.join(root, "source.git")],
      { env: environment },
    );
    await exec(
      "git",
      [
        "--git-dir",
        path.join(root, "source.git"),
        "config",
        "uploadpack.allowReachableSHA1InWant",
        "true",
      ],
      { env: environment },
    );
    const publish = async () => {
      await git(
        "push",
        "--no-verify",
        path.join(root, "source.git"),
        "HEAD:refs/heads/main",
      );
      return (await git("rev-parse", "HEAD")).stdout.trim();
    };
    const serve = (
      request: http.IncomingMessage,
      response: http.ServerResponse,
    ) => {
      if (stalled) {
        request.resume();
        return;
      }
      if (failure !== undefined) {
        request.resume();
        response.writeHead(failure).end();
        return;
      }
      if (redirect !== undefined) {
        response.writeHead(302, { location: redirect }).end();
        return;
      }
      if (dumb) {
        response
          .writeHead(200, { "content-type": "text/plain" })
          .end("dumb refs");
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/source.git/")) {
        response.writeHead(404).end();
        return;
      }
      const requested = request.headers["git-protocol"];
      const version =
        options.protocol !== 0 &&
        typeof requested === "string" &&
        requested.split(":").includes("version=2")
          ? 2
          : 0;
      protocols.push(version);
      const child = execFile(
        "git",
        ["http-backend"],
        {
          encoding: "buffer",
          maxBuffer: 32 * 1024 * 1024,
          env: {
            ...environment,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: request.method ?? "GET",
            CONTENT_TYPE: request.headers["content-type"] ?? "",
            // CGI passes the Git-Protocol header to the backend this way.
            ...(version === 2 ? { HTTP_GIT_PROTOCOL: "version=2" } : {}),
          },
        },
        (error, output) => {
          // Like a CGI host, answer with what the backend wrote even when it
          // exits nonzero, as upload-pack does after refusing a want.
          const boundary = output.indexOf("\r\n\r\n");
          if (
            (error !== null && typeof error.code !== "number") ||
            boundary < 0
          ) {
            response.writeHead(500).end();
            return;
          }
          let status = 200;
          for (const line of output
            .subarray(0, boundary)
            .toString("utf8")
            .split("\r\n")) {
            const colon = line.indexOf(":");
            const name = line.slice(0, colon);
            const value = line.slice(colon + 1).trim();
            if (name.toLowerCase() === "status")
              status = Number(value.split(" ")[0]);
            else response.setHeader(name, value);
          }
          response.writeHead(status).end(output.subarray(boundary + 4));
        },
      );
      request.pipe(child.stdin!);
    };
    server = http.createServer((request, response) => {
      requests.push(request.url ?? "");
      if (held === undefined) serve(request, response);
      else held.push(() => serve(request, response));
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No Git address");
    const origin = `http://127.0.0.1:${address.port}`;
    const running = server;
    return {
      url: `${origin}/source.git`,
      origin,
      commit: stdout.trim(),
      /** Each request's path and query, in arrival order. */
      requests,
      /** The protocol version each smart-HTTP request was served with. */
      protocols,
      redirectTo(url: string) {
        redirect = url;
      },
      stall() {
        stalled = true;
      },
      serveDumbRefs() {
        dumb = true;
      },
      /** Answers every request with this status and no body. */
      failWith(status: number) {
        failure = status;
      },
      /**
       * Holds requests unanswered until the returned function is called,
       * which serves them and every later request normally.
       */
      hold() {
        held = [];
        return () => {
          const waiting = held ?? [];
          held = undefined;
          for (const resume of waiting) resume();
        };
      },
      /** Commits these files over the current tree; returns the new commit. */
      async commitFiles(changes: Record<string, string>) {
        await commitFiles(changes);
        return publish();
      },
      async gitlink() {
        await git(
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${stdout.trim()},nested`,
        );
        await git("commit", "--no-verify", "-m", "Submodule fixture");
        return publish();
      },
      async symlink(relative: string, target: string) {
        await fs.symlink(target, path.join(tree, relative));
        await git("add", ".");
        await git("commit", "--no-verify", "-m", "Link fixture");
        return publish();
      },
      async close() {
        running.closeAllConnections();
        await new Promise<void>((resolve) => running.close(() => resolve()));
        await fs.rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server?.close();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
