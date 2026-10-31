import { createElement, Fragment, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSetup } from "../src/pages/settings/McpSetup.js";
import { WorkflowHostInstall } from "../src/pages/workflows/WorkflowHostInstall.js";

// The server renderer leaves collapsed panels and closed-over dialog portals
// empty, so render their content inline to read what the person sees.
vi.mock("antd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("antd")>()),
  Collapse: ({ items }: { items: { children: ReactNode }[] }) =>
    createElement(Fragment, null, ...items.map((item) => item.children)),
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement(Fragment, null, children) : null,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const refusal =
  "Use an HTTPS deployment URL or loopback HTTP without credentials, query, or fragment";

function mcpSetup(origin: string): string {
  vi.stubGlobal("window", { location: { origin } });
  vi.stubGlobal("document", { querySelector: () => null });
  return renderToString(createElement(McpSetup));
}

function hostInstall(deploymentUrl: string): string {
  return renderToString(
    createElement(WorkflowHostInstall, {
      workflowId: "workflow-1",
      publication: {
        id: "publication-1",
        workflowVersionId: "version-1",
        versionNumber: 1,
        versionName: "First",
        reviewId: "review-1",
        packageId: "package-1",
        packageHash: "a".repeat(64),
        publisherId: "person-1",
        publisherName: "Publisher",
        publishedAt: "2026-10-31T00:00:00.000Z",
        fileCount: 1,
      },
      deploymentUrl,
      onClose: () => undefined,
    }),
  );
}

describe("local host setup", () => {
  it("explains a deployment URL the MCP configuration cannot use instead of blanking the page", () => {
    expect(mcpSetup("https://badger.example")).toContain("mcpServers");

    const page = mcpSetup("http://badger.internal:8080");
    expect(page).toContain(refusal);
    expect(page).not.toContain("mcpServers");
  });

  it("explains a deployment URL the install command cannot use instead of blanking the dialog", () => {
    expect(hostInstall("https://badger.example/team")).toContain(
      "preview-install",
    );

    const dialog = hostInstall("http://127.0.0.2:4320/team");
    expect(dialog).toContain(refusal);
    expect(dialog).not.toContain("preview-install");
  });
});
