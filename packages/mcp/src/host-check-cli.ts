#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHostCheckMcp } from "./host-check.js";

if (process.argv.includes("--help")) {
  process.stdout.write(
    "badger-mcp-host-check\nSynthetic stdio tools, prompts, resources and URL elicitation for host application checks. No deployment or token is used. See docs/laptop-host-validation.md.\n",
  );
} else {
  const server = createHostCheckMcp();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void server.close().finally(() => process.stdin.pause());
  };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await server.connect(new StdioServerTransport());
  } catch {
    process.stderr.write(
      "Badger host check could not start its stdio connection.\n",
    );
    process.exitCode = 1;
  }
}
