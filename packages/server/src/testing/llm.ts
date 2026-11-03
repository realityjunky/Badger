import { createServer } from "node:http";

/** A synthetic LiteLLM-compatible HTTP provider; no internal service mocks. */
export async function startStubLlmProvider() {
  const requests: Record<string, unknown>[] = [];
  let status = 200;
  let delayMs = 0;
  let content: unknown = { scripts: [] };
  let raw: string | undefined;
  let requiredKey: string | undefined;
  let gate: Promise<void> | null = null;
  let release = () => {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    requests.push(body);
    const reply =
      raw ??
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(content) },
          },
        ],
      });
    const replyStatus =
      requiredKey !== undefined &&
      request.headers.authorization !== `Bearer ${requiredKey}`
        ? 401
        : status;
    if (gate) await gate;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    response.writeHead(replyStatus, { "content-type": "application/json" });
    response.end(reply);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Provider stub did not listen");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    holdResponses() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseResponses() {
      release();
      gate = null;
    },
    requireKey(value: string) {
      requiredKey = value;
    },
    respond(
      value: unknown,
      options: { status?: number; delayMs?: number; raw?: string } = {},
    ) {
      content = value;
      status = options.status ?? 200;
      delayMs = options.delayMs ?? 0;
      raw = options.raw;
    },
    async close() {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
