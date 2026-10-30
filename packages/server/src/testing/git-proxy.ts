import http from "node:http";
import net from "node:net";

/** A forwarding proxy; real Git HTTP traffic must cross the recorded tunnels. */
export async function startStubGitProxy() {
  const targets: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_request, response) =>
    response.writeHead(502).end(),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, socket, head) => {
    const target = new URL(`http://${request.url}`);
    targets.push(target.host);
    const upstream = net.connect(Number(target.port), target.hostname);
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No proxy address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    targets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
