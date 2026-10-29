import { createServer } from "node:http";
import { applyMigrations } from "./database/migrations.js";
import { createService, type ServiceOptions } from "./http/service.js";

export interface StartedServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function urlHost(host: string): string {
  const display =
    host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return display.includes(":") ? `[${display}]` : display;
}

/**
 * Applies the reviewed migrations, then serves. Migrations run before the
 * socket opens, so no request ever sees a half-migrated schema.
 */
export async function startHttpServer(
  options: ServiceOptions,
): Promise<StartedServer> {
  await applyMigrations(options.database, options.migrations, options.clock);

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.config.port, options.config.host);
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? address.port
      : options.config.port;
  // The handler needs the bound port, which BADGER_PORT=0 leaves to the OS.
  // No request is read before this line runs.
  const service = createService(options, port);
  server.on("request", service.handler);

  return {
    url: `http://${urlHost(options.config.host)}:${port}`,
    port,
    close: () => {
      service.close();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
