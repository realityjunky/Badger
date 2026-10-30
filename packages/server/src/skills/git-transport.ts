import { once } from "node:events";
import http from "node:http";
import { EnvHttpProxyAgent, fetch } from "undici";
import type { ServiceConfig } from "../config.js";
import { RequestError } from "../http/errors.js";

/**
 * Git sees only these two smart-HTTP operations on one registered repository.
 * In particular, dumb-HTTP alternates and redirects cannot name another URL.
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
  const timeout = setTimeout(() => controller.abort(), config.git.timeoutMs);
  let failure: RequestError | undefined;
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
      const response = await fetch(repository + request.url, {
        method: request.method,
        headers,
        ...(pack ? { body: Buffer.concat(chunks) } : {}),
        dispatcher: agent,
        redirect: "error",
        signal: controller.signal,
      });
      const expectedType = `application/x-git-upload-pack-${advertise ? "advertisement" : "result"}`;
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
      failure ??=
        error instanceof RequestError
          ? error
          : new RequestError(
              400,
              "The registered repository could not supply that commit",
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
