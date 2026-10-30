import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const resourceUri = "badger-host-check://example";
const referenceUrl = "https://modelcontextprotocol.io/";

/** Synthetic diagnostics, separate from the authenticated Badger MCP. */
export function createHostCheckMcp(): Server {
  const server = new Server(
    { name: "badger-host-check", version: "0.0.0" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        "This is a synthetic host compatibility probe. It needs no token and cannot operate Badger. Use the host's prompt and resource interfaces, then call host_check_url and host_check_report. Record the application version and what the person observed alongside the report.",
    },
  );
  const observations = {
    tools: false,
    promptRequested: false,
    resourceRead: false,
  };
  let outcome:
    | "not_requested"
    | "not_advertised"
    | "accept"
    | "decline"
    | "cancel"
    | "failed" = "not_requested";
  const advertised = () =>
    server.getClientCapabilities()?.elicitation?.url !== undefined;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "host_check_report",
        description:
          "Return this connection's synthetic host check observations. No files or service records are written.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "host_check_url",
        description:
          "Ask the host to offer the public MCP documentation through URL elicitation; always return the same clickable link. This never approves a Badger action.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
    ],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "host_check_prompt",
        description: "Show the synthetic BLUE-17 host prompt marker.",
      },
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== "host_check_prompt")
      throw new Error("Unknown host check prompt");
    observations.promptRequested = true;
    return {
      messages: [
        {
          role: "user",
          content: { type: "text", text: "Badger host prompt check: BLUE-17" },
        },
      ],
    };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: resourceUri,
        name: "Host check resource",
        mimeType: "text/plain",
        description: "Read the synthetic ORANGE-42 host resource marker.",
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== resourceUri)
      throw new Error("Unknown host check resource");
    observations.resourceRead = true;
    return {
      contents: [
        {
          uri: resourceUri,
          mimeType: "text/plain",
          text: "Badger host resource check: ORANGE-42",
        },
      ],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (
      !["host_check_report", "host_check_url"].includes(request.params.name) ||
      Object.keys(request.params.arguments ?? {}).length
    )
      return {
        isError: true,
        content: [
          { type: "text", text: "Choose a host check tool without arguments." },
        ],
      };
    observations.tools = true;
    if (request.params.name === "host_check_url") {
      outcome = "not_advertised";
      if (advertised()) {
        try {
          const response = await server.elicitInput(
            {
              mode: "url",
              message:
                "Open the public MCP documentation to check this host's URL elicitation. No Badger action is approved.",
              elicitationId: randomUUID(),
              url: referenceUrl,
            },
            { timeout: 30_000 },
          );
          outcome = response.action;
        } catch {
          outcome = "failed";
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: referenceUrl,
              advertised: advertised(),
              outcome,
            }),
          },
        ],
      };
    }
    const client = server.getClientVersion();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            probe: "badger-host-check-v1",
            checkedAt: new Date().toISOString(),
            platform: process.platform,
            architecture: process.arch,
            nodeVersion: process.versions.node,
            client: client
              ? { name: client.name, version: client.version }
              : null,
            observations,
            urlElicitation: { advertised: advertised(), outcome },
          }),
        },
      ],
    };
  });
  return server;
}
