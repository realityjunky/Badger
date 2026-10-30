import { afterEach, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ElicitRequestSchema,
  type ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(capabilities: ClientCapabilities = {}) {
  const client = new Client(
    { name: "host-check-sdk", version: "1.0.0" },
    { capabilities },
  );
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("../dist/src/host-check-cli.js", import.meta.url),
        ),
      ],
      env: { BADGER_TOKEN: "unused-fixture-secret" },
      stderr: "pipe",
    }),
  );
  return client;
}

async function call(client: Client, name: string) {
  const result = await client.callTool({ name, arguments: {} });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse((result.content as { text: string }[])[0].text);
}

it("probes tools, prompts, resources and URL elicitation through a real stdio connection without deployment credentials", async () => {
  const client = await connect({ elicitation: { url: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    expect(request.params).toMatchObject({
      mode: "url",
      url: "https://modelcontextprotocol.io/",
    });
    return { action: "accept" };
  });
  expect(client.getServerCapabilities()).toMatchObject({
    tools: {},
    prompts: {},
    resources: {},
  });
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
    "host_check_report",
    "host_check_url",
  ]);
  expect((await client.listPrompts()).prompts).toMatchObject([
    { name: "host_check_prompt" },
  ]);
  expect(await client.getPrompt({ name: "host_check_prompt" })).toMatchObject({
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Badger host prompt check: BLUE-17" },
      },
    ],
  });
  const { resources } = await client.listResources();
  expect(resources).toMatchObject([{ uri: "badger-host-check://example" }]);
  expect(await client.readResource({ uri: resources[0].uri })).toMatchObject({
    contents: [{ text: "Badger host resource check: ORANGE-42" }],
  });
  expect(await call(client, "host_check_url")).toMatchObject({
    url: "https://modelcontextprotocol.io/",
    advertised: true,
    outcome: "accept",
  });
  const report = await call(client, "host_check_report");
  expect(report).toMatchObject({
    probe: "badger-host-check-v1",
    client: { name: "host-check-sdk", version: "1.0.0" },
    platform: process.platform,
    observations: { tools: true, promptRequested: true, resourceRead: true },
    urlElicitation: { advertised: true, outcome: "accept" },
  });
  expect(JSON.stringify(report)).not.toContain("unused-fixture-secret");
  expect(
    (await client.callTool({ name: "approve", arguments: {} })).isError,
  ).toBe(true);
});

it.each(["unsupported", "decline", "cancel", "failed"] as const)(
  "preserves the public reference link when URL elicitation is %s",
  async (response) => {
    const client = await connect(
      response === "unsupported" ? {} : { elicitation: { url: {} } },
    );
    if (response !== "unsupported")
      client.setRequestHandler(ElicitRequestSchema, async () => {
        if (response === "failed") throw new Error("Synthetic host failure");
        return { action: response };
      });
    expect(await call(client, "host_check_url")).toEqual({
      url: "https://modelcontextprotocol.io/",
      advertised: response !== "unsupported",
      outcome: response === "unsupported" ? "not_advertised" : response,
    });
    expect((await call(client, "host_check_report")).observations).toEqual({
      tools: true,
      promptRequested: false,
      resourceRead: false,
    });
  },
);
