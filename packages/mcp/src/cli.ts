#!/usr/bin/env node
import { hostname } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createExpertMcp } from "./index.js";

try {
  const server = createExpertMcp({
    url: process.env["BADGER_URL"] ?? "",
    token: process.env["BADGER_TOKEN"] ?? "",
    agentHost: process.env["BADGER_AGENT_HOST"] ?? hostname(),
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void server
      .close()
      .catch(() => {
        process.stderr.write(
          "Badger MCP could not remove its temporary results.\n",
        );
        process.exitCode = 1;
      })
      .finally(() => process.stdin.pause());
  };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
} catch {
  // stdout belongs to MCP, and configuration may contain credentials.
  process.stderr.write(
    "Badger MCP could not start. Check BADGER_URL, BADGER_TOKEN, and BADGER_AGENT_HOST.\n",
  );
  process.exitCode = 1;
}
