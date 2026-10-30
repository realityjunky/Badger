#!/usr/bin/env node
import { hostname } from "node:os";
import { domainToASCII } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigurationError, validAgentHost } from "./api.js";
import { createBadgerMcp } from "./index.js";

/** A machine name outside printable ASCII is sent in its IDNA form. */
function defaultAgentHost(): string {
  const name = hostname();
  if (validAgentHost(name)) return name;
  const ascii = domainToASCII(name);
  return validAgentHost(ascii) ? ascii : "unnamed-host";
}

try {
  const profile = process.env["BADGER_MCP_PROFILE"] ?? "auto";
  if (
    profile !== "auto" &&
    profile !== "engineer" &&
    profile !== "expert" &&
    profile !== "operator"
  )
    throw new ConfigurationError(
      "BADGER_MCP_PROFILE must be auto, engineer, expert, or operator",
    );
  const server = createBadgerMcp({
    profile,
    url: process.env["BADGER_URL"] ?? "",
    token: process.env["BADGER_TOKEN"] ?? "",
    agentHost: process.env["BADGER_AGENT_HOST"] ?? defaultAgentHost(),
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
} catch (error) {
  // stdout belongs to MCP, and configuration may contain credentials, so
  // only messages that name a setting, never its value, are shown.
  process.stderr.write(
    error instanceof ConfigurationError
      ? `Badger MCP could not start: ${error.message}.\n`
      : "Badger MCP could not start. Check BADGER_URL, BADGER_TOKEN, and BADGER_AGENT_HOST.\n",
  );
  process.exitCode = 1;
}
