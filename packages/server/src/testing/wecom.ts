import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { WsFrame } from "@wecom/aibot-node-sdk";
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

export interface StubWeComLongConnection {
  readonly url: string;
  readonly requests: readonly WsFrame<Record<string, unknown>>[];
  readonly connections: number;
  setFailure(code: number | null, command?: string): void;
  receive(input: {
    botId: string;
    userId: string;
    text: string;
    messageId?: string;
    chatType?: "single" | "group";
  }): void;
  disconnect(): void;
  close(): Promise<void>;
}

export async function startStubWeComLongConnection(): Promise<StubWeComLongConnection> {
  const requests: WsFrame<Record<string, unknown>>[] = [];
  const failures = new Map<string, number>();
  const bots = new Map<string, WebSocket>();
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: 64 * 1024,
  });
  server.on("connection", (socket) => {
    socket.on("error", () => undefined);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as WsFrame<
        Record<string, unknown>
      >;
      requests.push(frame);
      const code = failures.get(frame.cmd ?? "") ?? 0;
      if (frame.cmd === "aibot_subscribe" && code === 0) {
        const botId = String(frame.body?.bot_id);
        const previous = bots.get(botId);
        if (
          previous !== undefined &&
          previous !== socket &&
          previous.readyState === WebSocket.OPEN
        )
          previous.send(
            JSON.stringify({
              cmd: "aibot_event_callback",
              headers: { req_id: randomUUID() },
              body: {
                aibotid: botId,
                msgtype: "event",
                event: { eventtype: "disconnected_event" },
              },
            }),
          );
        bots.set(botId, socket);
        socket.on("close", () => {
          if (bots.get(botId) === socket) bots.delete(botId);
        });
      }
      socket.send(
        JSON.stringify({
          headers: frame.headers,
          errcode: code,
          errmsg: code === 0 ? "ok" : "remote-secret-MUST-NOT-LOG",
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Stub WebSocket did not listen");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    requests,
    get connections() {
      return server.clients.size;
    },
    setFailure: (code, command = "aibot_send_msg") => {
      if (code === null) failures.delete(command);
      else failures.set(command, code);
    },
    receive: (input) => {
      const socket = bots.get(input.botId);
      if (socket === undefined || socket.readyState !== WebSocket.OPEN)
        throw new Error("Robot is not connected");
      socket.send(
        JSON.stringify({
          cmd: "aibot_msg_callback",
          headers: { req_id: randomUUID() },
          body: {
            aibotid: input.botId,
            msgid: input.messageId ?? randomUUID(),
            chattype: input.chatType ?? "single",
            ...(input.chatType === "group" ? { chatid: "test-group" } : {}),
            from: { userid: input.userId },
            msgtype: "text",
            text: { content: input.text },
          },
        }),
      );
    },
    disconnect: () => {
      for (const socket of server.clients)
        socket.close(1012, "Restarting stub");
    },
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
