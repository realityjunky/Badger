import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BadgerApi, BadgerApiError, type ExpertMcpOptions } from "./api.js";
import { expertTools, questionnairePath } from "./tools.js";
import { ResultResources } from "./resources.js";
export type { ExpertMcpOptions } from "./api.js";

class ExpertMcpServer extends Server {
  constructor(private readonly results: ResultResources) {
    super(
      { name: "badger-expert", version: "0.0.0" },
      {
        capabilities: { tools: { listChanged: true }, resources: {} },
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

const CAPABILITY_MILLISECONDS = 30_000;

export function createExpertMcp(options: ExpertMcpOptions): Server {
  const api = new BadgerApi(options);
  const resources = new ResultResources();
  const server = new ExpertMcpServer(resources);
  const tools = expertTools(api, server);
  // Each capability read is a token request, and tokens are rate limited, so
  // calls reuse a recent read. The service still checks every request.
  let recent: { at: number; tools: typeof tools } | undefined;
  let listed: string | undefined;
  async function permitted(fresh = false) {
    if (
      !fresh &&
      recent !== undefined &&
      Date.now() - recent.at < CAPABILITY_MILLISECONDS
    )
      return recent.tools;
    const { capabilities } = await api.request<{
      capabilities: Record<string, boolean>;
    }>("/me/mcp");
    const allowed = tools.filter(
      (tool) => tool.permission === undefined || capabilities[tool.permission],
    );
    recent = { at: Date.now(), tools: allowed };
    const names = allowed.map((tool) => tool.definition.name).join(",");
    if (listed !== undefined && names !== listed)
      void server.sendToolListChanged().catch(() => undefined);
    return allowed;
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allowed = await permitted(true);
    listed = allowed.map((tool) => tool.definition.name).join(",");
    return { tools: allowed.map((tool) => tool.definition) };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    await permitted();
    return { resources: resources.list() };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    resources.read(request.params.uri),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const named = (allowed: typeof tools) =>
        allowed.find((tool) => tool.definition.name === request.params.name);
      // A role granted since the last read shows up on a fresh one.
      const tool = named(await permitted()) ?? named(await permitted(true));
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
      // A refusal may mean roles changed; a fresh read updates the tool list.
      if (error instanceof BadgerApiError && error.status === 403)
        await permitted(true).catch(() => undefined);
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
