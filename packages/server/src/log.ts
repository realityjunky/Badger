export interface Logger {
  info(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

/** One JSON object per line; secrets are never logged. */
export function createJsonLogger(stream: NodeJS.WritableStream): Logger {
  const write = (level: "info" | "error", fields: Record<string, unknown>) => {
    stream.write(
      `${JSON.stringify({ level, ...fields, time: new Date().toISOString() })}\n`,
    );
  };
  return {
    info: (fields) => write("info", fields),
    error: (fields) => write("error", fields),
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};
