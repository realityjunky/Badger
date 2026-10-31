import { describe, expect, it } from "vitest";
import {
  localInstallCommand,
  renderMcpConfiguration,
} from "@realityjunky/badger-hosts/configuration";
import { hostSetupText } from "../src/util/hostSetup.js";

const refusal =
  "Use an HTTPS deployment URL or loopback HTTP without credentials, query, or fragment";

describe("local host setup text", () => {
  it("returns the reason a deployment URL cannot be used instead of throwing", () => {
    const configuration = (deploymentUrl: string) =>
      hostSetupText(() =>
        renderMcpConfiguration("claude", {
          deploymentUrl,
          command: "badger-mcp",
          profile: "auto",
        }),
      );
    expect(configuration("https://badger.example").text).toContain(
      "mcpServers",
    );
    expect(configuration("http://badger.internal:8080")).toEqual({
      text: "",
      failure: refusal,
    });

    const install = (deploymentUrl: string) =>
      hostSetupText(() =>
        localInstallCommand({
          deploymentUrl,
          workflowId: "workflow-1",
          publicationId: "publication-1",
          packageHash: "a".repeat(64),
          host: "workbuddy",
          scope: "project",
        }),
      );
    expect(install("https://badger.example/team")).toMatchObject({
      failure: null,
      text: expect.stringContaining("preview-install"),
    });
    expect(install("http://127.0.0.2:4320/team")).toEqual({
      text: "",
      failure: refusal,
    });
  });

  it("returns the reason an MCP executable cannot be used", () => {
    expect(
      hostSetupText(() =>
        renderMcpConfiguration("codex", {
          deploymentUrl: "https://badger.example",
          command: "badger-mcp\t--debug",
        }),
      ).failure,
    ).toBe("Set an MCP executable without control characters");
  });
});
