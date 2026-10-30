import { once } from "node:events";
import http from "node:http";
import { EnvHttpProxyAgent, fetch } from "undici";
import type { ServiceConfig } from "../config.js";
import { RequestError } from "../http/errors.js";

/** Joins one smart-HTTP operation to the repository's path. */
function operationUrl(repository: string, advertise: boolean): URL {
  const url = new URL(repository);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${advertise ? "info/refs" : "git-upload-pack"}`;
  url.search = advertise ? "?service=git-upload-pack" : "";
  url.hash = "";
  return url;
}

/**
 * Git sees only these two smart-HTTP operations on one registered repository.
 * In particular, dumb-HTTP alternates and redirects cannot name another URL.
 * A host that cannot be reached, times out, or answers 5xx or 429 is
 * unavailable (503); any other answer that is not smart HTTP is refused (400).
 */
export async function openGitTransport(
  config: ServiceConfig,
  repository: string,
) {
  const agent = new EnvHttpProxyAgent({
    httpsProxy: config.git.httpsProxy,
    httpProxy: config.git.httpProxy,
    noProxy: config.git.noProxy,
  });
  const controller = new AbortController();
  let failure: RequestError | undefined;
  const timeout = setTimeout(() => {
    failure ??= new RequestError(503, "Git import timed out");
    controller.abort();
  }, config.git.timeoutMs);
  let received = 0;
  const server = http.createServer((request, reply) => {
    const advertise =
      request.method === "GET" &&
      request.url === "/info/refs?service=git-upload-pack";
    const pack =
      request.method === "POST" && request.url === "/git-upload-pack";
    if (!advertise && !pack) {
      reply.writeHead(404).end();
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      let sent = 0;
      for await (const chunk of request) {
        sent += chunk.length;
        if (sent > 1024 * 1024)
          throw new RequestError(
            413,
            "Git negotiation exceeds the request limit",
          );
        chunks.push(Buffer.from(chunk));
      }
      const headers: Record<string, string> = {};
      if (pack)
        headers["content-type"] = "application/x-git-upload-pack-request";
      if (typeof request.headers["git-protocol"] === "string")
        headers["git-protocol"] = request.headers["git-protocol"];
      const response = await fetch(operationUrl(repository, advertise), {
        method: request.method,
        headers,
        ...(pack ? { body: Buffer.concat(chunks) } : {}),
        dispatcher: agent,
        // A redirect is answered, never followed, and refused below.
        redirect: "manual",
        signal: controller.signal,
      });
      const expectedType = `application/x-git-upload-pack-${advertise ? "advertisement" : "result"}`;
      if (response.status >= 500 || response.status === 429) {
        await response.body?.cancel();
        throw new RequestError(
          503,
          "The Git host failed to answer; try again later",
        );
      }
      if (
        !response.ok ||
        response.headers.get("content-type")?.split(";")[0] !== expectedType
      ) {
        await response.body?.cancel();
        throw new RequestError(
          400,
          "The repository must support Git smart HTTP without redirects",
        );
      }
      reply.writeHead(200, { "content-type": expectedType });
      for await (const chunk of response.body ?? []) {
        received += chunk.length;
        if (received > config.git.maxRepositoryBytes)
          throw new RequestError(
            413,
            "Git repository exceeds the fetch size limit",
          );
        if (!reply.write(chunk))
          await once(reply, "drain", { signal: controller.signal });
      }
      reply.end();
    })().catch((error: unknown) => {
      // Anything else is a failed connection, such as a refused or reset one.
      failure ??=
        error instanceof RequestError
          ? error
          : new RequestError(
              503,
              "The Git host could not be reached; try again later",
            );
      controller.abort();
      reply.destroy();
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    clearTimeout(timeout);
    controller.abort();
    await agent.destroy();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Git transport has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    failure: () => failure,
    async close() {
      clearTimeout(timeout);
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await agent.destroy();
    },
  };
}
