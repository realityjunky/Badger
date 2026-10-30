import { createServer } from "node:http";
import type {
  NotificationChannel,
  RobotMessage,
} from "../notifications/port.js";
import { WeComChannel } from "../notifications/wecom.js";

export interface StubWeComRobot {
  readonly requests: readonly { key: string | null; message: RobotMessage }[];
  channel: NotificationChannel;
  setFailure(
    status: number | null,
    errcode?: number,
    retryAfterSeconds?: number,
  ): void;
  close(): Promise<void>;
}

export async function startStubWeComRobot(): Promise<StubWeComRobot> {
  const requests: { key: string | null; message: RobotMessage }[] = [];
  let failure: {
    status: number;
    errcode: number;
    retryAfterSeconds?: number;
  } | null = null;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      key: new URL(request.url!, "http://stub.invalid").searchParams.get("key"),
      message: JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as RobotMessage,
    });
    response.writeHead(failure?.status ?? 200, {
      "content-type": "application/json",
      ...(failure?.retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(failure.retryAfterSeconds) }),
    });
    response.end(
      JSON.stringify({
        errcode: failure?.errcode ?? 0,
        errmsg:
          failure === null ? "ok" : "remote response must not appear in logs",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Stub did not listen");
  return {
    requests,
    channel: new WeComChannel(
      { httpsProxy: "", httpProxy: "", noProxy: "*" },
      `http://127.0.0.1:${address.port}`,
    ),
    setFailure: (status, errcode = 0, retryAfterSeconds) => {
      failure = status === null ? null : { status, errcode, retryAfterSeconds };
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** A proxy that records CONNECT requests and refuses the upstream tunnel. */
export async function startStubHttpsProxy() {
  const targets: string[] = [];
  const server = createServer((_request, response) =>
    response.writeHead(502).end(),
  );
  server.on("connect", (request, socket) => {
    targets.push(request.url ?? "");
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Stub proxy did not listen");
  return {
    targets,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
