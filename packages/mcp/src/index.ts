import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BadgerApi, type ExpertMcpOptions } from "./api.js";
import { expertTools, questionnairePath } from "./tools.js";
import { ResultResources } from "./resources.js";
export type { ExpertMcpOptions } from "./api.js";

class ExpertMcpServer extends Server {
  constructor(private readonly results: ResultResources) {
    super(
      { name: "badger-expert", version: "0.0.0" },
      {
        capabilities: { tools: {}, resources: {} },
        instructions:
          "Submit only what the user said. Never infer an expert's answers or sign off for a person. Save and submit only with the user's instruction. People sign off in the dashboard. Read large results from the returned private local file or MCP resource.",
      },
    );
    this.onclose = () => {
      void results.close().catch(() => undefined);
    };
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      await this.results.close();
    }
  }
}

export function createExpertMcp(options: ExpertMcpOptions): Server {
  const api = new BadgerApi(options);
  const resources = new ResultResources();
  const server = new ExpertMcpServer(resources);
  const tools = expertTools(api, server);
  async function permitted() {
    const { capabilities } = await api.request<{
      capabilities: Record<string, boolean>;
    }>("/me/mcp");
    return tools.filter(
      (tool) => tool.permission === undefined || capabilities[tool.permission],
    );
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await permitted()).map((tool) => tool.definition),
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    await permitted();
    return { resources: resources.list() };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    resources.read(request.params.uri),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const tool = (await permitted()).find(
        (tool) => tool.definition.name === request.params.name,
      );
      if (tool === undefined)
        throw new Error(
          "This tool is outside your current roles or token scopes",
        );
      const args = request.params.arguments ?? {};
      const value = await tool.run(args);
      return await resources.result(value, async () => {
        if (!(await permitted()).includes(tool))
          throw new Error(
            "This result is outside your current roles or token scopes",
          );
        if (tool.permission === undefined) return tool.run(args);
        // A mutation's resource must never repeat the mutation. Check its
        // target's read permissions before returning the saved response.
        if (
          typeof args.workflowId === "string" &&
          typeof args.versionId === "string"
        ) {
          await api.request(
            questionnairePath({
              workflowId: args.workflowId,
              versionId: args.versionId,
            }),
          );
        } else if (typeof args.skillId === "string") {
          await api.request(`/skills/${encodeURIComponent(args.skillId)}`);
        }
        return value;
      });
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              error instanceof Error
                ? error.message.slice(0, 1000)
                : "Badger request failed",
          },
        ],
      };
    }
  });
  return server;
}
