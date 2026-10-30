import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A real, read-only smart-HTTP Git remote; no service internals are replaced. */
export async function startStubGitRepository(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-git-remote-"));
  const tree = path.join(root, "tree");
  await fs.mkdir(tree);
  const git = (...args: string[]) => exec("git", ["-C", tree, ...args]);
  const requests: string[] = [];
  let redirect: string | undefined;
  let stalled = false;
  let dumb = false;
  let server: http.Server | undefined;
  try {
    await git("init", "--template=");
    await git("config", "user.name", "Test author");
    await git("config", "user.email", "author@example.com");
    for (const [relative, content] of Object.entries(files)) {
      const destination = path.join(tree, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }
    await git("add", ".");
    await git("commit", "--no-verify", "-m", "Skill fixture");
    const { stdout } = await git("rev-parse", "HEAD");
    await exec("git", [
      "clone",
      "--bare",
      "--template=",
      tree,
      path.join(root, "source.git"),
    ]);
    await exec("git", [
      "--git-dir",
      path.join(root, "source.git"),
      "config",
      "uploadpack.allowReachableSHA1InWant",
      "true",
    ]);
    server = http.createServer((request, response) => {
      requests.push(request.url ?? "");
      if (stalled) {
        request.resume();
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
      const child = execFile(
        "git",
        ["http-backend"],
        {
          encoding: "buffer",
          maxBuffer: 32 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: request.method ?? "GET",
            CONTENT_TYPE: request.headers["content-type"] ?? "",
          },
        },
        (error, output) => {
          if (error) {
            response.writeHead(500).end();
            return;
          }
          const boundary = output.indexOf("\r\n\r\n");
          if (boundary < 0) {
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
      requests,
      redirectTo(url: string) {
        redirect = url;
      },
      stall() {
        stalled = true;
      },
      serveDumbRefs() {
        dumb = true;
      },
      async gitlink() {
        await git(
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${stdout.trim()},nested`,
        );
        await git("commit", "--no-verify", "-m", "Submodule fixture");
        await git(
          "push",
          "--no-verify",
          path.join(root, "source.git"),
          "HEAD:refs/heads/main",
        );
        return (await git("rev-parse", "HEAD")).stdout.trim();
      },
      async symlink(relative: string, target: string) {
        await fs.symlink(target, path.join(tree, relative));
        await git("add", ".");
        await git("commit", "--no-verify", "-m", "Link fixture");
        await git(
          "push",
          "--no-verify",
          path.join(root, "source.git"),
          "HEAD:refs/heads/main",
        );
        return (await git("rev-parse", "HEAD")).stdout.trim();
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
