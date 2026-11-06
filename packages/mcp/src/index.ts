import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  BadgerApi,
  BadgerApiError,
  isRateLimitedBadgerFailure,
  isRetryableBadgerFailure,
  type ExpertMcpOptions,
} from "./api.js";
import { expertTools, questionnairePath } from "./tools.js";
import { ResultResources } from "./resources.js";
import { engineerTools } from "./engineer-tools.js";
import { jobsPath } from "./jobs.js";
import { LocalDraftingSessions } from "./drafting-sessions.js";
import { hostTools, LocalHostPreviews } from "./host-tools.js";
import { LocalRuns, operatorTools } from "./operator-tools.js";
export type { ExpertMcpOptions } from "./api.js";

class BadgerMcpServer extends Server {
  constructor(
    private readonly results: ResultResources,
    private readonly hostPreviews: LocalHostPreviews,
    private readonly runs: LocalRuns,
    private readonly drafting: LocalDraftingSessions,
    profile: string,
  ) {
    super(
      { name: `badger-${profile}`, version: "0.0.0" },
      {
        capabilities: { tools: { listChanged: true }, resources: {} },
        instructions:
          "Submit only what the user said. Never infer an expert's answers or sign off for a person. Save and submit only with the user's instruction. Engineers' Agents may draft suggestions from a claimed job's pinned evidence; those suggestions never become records until a person accepts them. People sign off in the dashboard. Read large results from the returned private local file or MCP resource.",
      },
    );
    this.onclose = () => {
      void results.close().catch(() => undefined);
      void hostPreviews.close().catch(() => undefined);
      void runs.close().catch(() => undefined);
      void drafting.close().catch(() => undefined);
    };
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      await this.results.close();
      await this.hostPreviews.close();
      await this.runs.close();
      await this.drafting.close();
    }
  }
}

const CAPABILITY_MILLISECONDS = 30_000;

export function createExpertMcp(options: ExpertMcpOptions): Server {
  return createBadgerMcp({ ...options, profile: "expert" });
}
export function createEngineerMcp(options: ExpertMcpOptions): Server {
  return createBadgerMcp({ ...options, profile: "engineer" });
}
export function createBadgerMcp(
  options: ExpertMcpOptions & {
    profile?: "expert" | "engineer" | "operator" | "auto";
  },
): Server {
  const api = new BadgerApi(options);
  const resources = new ResultResources(options.maxInlineBytes);
  const profile = options.profile ?? "auto";
  const hostPreviews = new LocalHostPreviews();
  const runs = new LocalRuns(api, options.agentHost);
  const drafting = new LocalDraftingSessions(api);
  const server = new BadgerMcpServer(
    resources,
    hostPreviews,
    runs,
    drafting,
    profile,
  );
  const expert = expertTools(api, server);
  const common = new Set(["whoami", "inbox", "open_dashboard"]);
  const tools =
    profile === "expert"
      ? expert
      : profile === "operator"
        ? [
            ...expert.filter((t) => common.has(t.definition.name)),
            ...hostTools(api, hostPreviews),
            ...operatorTools(api, runs, options.agentHost),
          ]
        : [
            ...expert.filter(
              (t) =>
                profile === "auto" ||
                common.has(t.definition.name) ||
                [
                  "answer_context",
                  "save_answer",
                  "submit_answer",
                  "upload_attachment",
                  "my_questions",
                ].includes(t.definition.name),
            ),
            ...engineerTools(api, drafting),
            ...operatorTools(api, runs, options.agentHost),
            ...(profile === "auto" ? hostTools(api, hostPreviews) : []),
          ];
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
    let capabilities: Record<string, boolean>;
    try {
      const value = await api.request<{
        capabilities: Record<string, boolean>;
      }>("/me/mcp", "GET", undefined, recent ? 1 : 30);
      if (
        !value ||
        !value.capabilities ||
        typeof value.capabilities !== "object" ||
        Array.isArray(value.capabilities) ||
        Object.values(value.capabilities).some(
          (allowed) => typeof allowed !== "boolean",
        )
      )
        throw new Error("Badger returned malformed MCP capabilities");
      capabilities = value.capabilities;
      if (!capabilities.operateRuns) runs.forgetAuthorization();
    } catch (error) {
      if (recent && isRetryableBadgerFailure(error)) {
        capabilities = Object.fromEntries(
          recent.tools.flatMap((tool) =>
            tool.permission ? [[tool.permission, true]] : [],
          ),
        );
      } else {
        // A rate limit is not a denial, so it keeps every successful check.
        if (!isRateLimitedBadgerFailure(error)) {
          recent = undefined;
          runs.forgetAuthorization();
        }
        throw error;
      }
    }
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
        if (tool.definition.annotations?.readOnlyHint) return tool.run(args);
        // A mutation's resource must never repeat the mutation. Check its
        // target's read permissions before returning the saved response.
        if (
          typeof args.projectRoot === "string" &&
          typeof args.runId === "string"
        ) {
          await runs.binding({
            projectRoot: args.projectRoot,
            runId: args.runId,
          });
        } else if (
          typeof args.workflowId === "string" &&
          typeof args.versionId === "string"
        ) {
          if (typeof args.jobId === "string")
            await api.request(
              `${jobsPath({ workflowId: args.workflowId, versionId: args.versionId })}/${encodeURIComponent(args.jobId)}`,
            );
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
                ? "finding" in error
                  ? error.message
                  : error.message.slice(0, 1000)
                : "Badger request failed",
          },
        ],
      };
    }
  });
  return server;
}
