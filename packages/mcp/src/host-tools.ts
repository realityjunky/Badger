import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  previewInstall,
  previewUninstall,
  commitHostPlan,
  saveHostPlan,
  readHostPlan,
  removeHostPlan,
  verifyPublishedPackage,
  publishedPackagePath,
  type HostPlan,
  type PublishedIdentity,
  type PublishedPackageRead,
} from "@realityjunky/badger-hosts";
import type { BadgerApi } from "./api.js";
import { tool, id } from "./tools.js";

/** The MCP only commits a preview made by this connection. */
export class LocalHostPreviews {
  private readonly entries = new Map<
    string,
    { file: string; plan: HostPlan }
  >();
  private closed = false;
  async save(plan: HostPlan) {
    if (this.closed) throw new Error("The MCP connection is closed");
    if (this.entries.size >= 16)
      throw new Error("Too many local previews; reconnect to discard them");
    const file = await saveHostPlan(plan);
    if (this.closed) {
      await removeHostPlan(file);
      throw new Error("The MCP connection is closed");
    }
    const previewId = randomUUID();
    this.entries.set(previewId, { file, plan });
    return { previewId, previewFile: file, preview: plan.preview };
  }
  async read(previewId: string) {
    const entry = this.entries.get(previewId);
    if (!entry) throw new Error("Preview again on this MCP connection");
    const saved = await readHostPlan(entry.file);
    if (JSON.stringify(saved) !== JSON.stringify(entry.plan))
      throw new Error("The private preview file changed; preview again");
    return saved;
  }
  async discard(previewId: string) {
    const entry = this.entries.get(previewId);
    if (entry) {
      this.entries.delete(previewId);
      await removeHostPlan(entry.file);
    }
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.entries.keys()].map((id) => this.discard(id)));
  }
}
const target = z
  .object({
    host: z.enum(["claude", "codex", "workbuddy"]),
    scope: z.enum(["project", "user"]),
    projectRoot: z.string().min(1).max(4096),
    homeRoot: z.string().min(1).max(4096),
  })
  .strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export function hostTools(api: BadgerApi, previews: LocalHostPreviews) {
  async function published(identity: PublishedIdentity) {
    const value = await api.request<PublishedPackageRead>(
      publishedPackagePath(identity),
    );
    return verifyPublishedPackage(value, identity);
  }
  async function commit(
    previewId: string,
    digest: string | undefined,
    workflowId: string,
    action: "install" | "uninstall",
  ) {
    if (!digest)
      throw new Error(
        "Quote the exact local preview digest after the person confirms",
      );
    const plan = await previews.read(previewId);
    if (
      plan.preview.action !== action ||
      plan.preview.publication.workflowId !== workflowId
    )
      throw new Error("The preview belongs to another action or workflow");
    // Recheck current service access and published bytes immediately before local writes.
    await published(plan.preview.publication);
    const result = await commitHostPlan(plan, { digest, confirmed: true });
    await previews.discard(previewId);
    return result;
  }
  return [
    tool(
      "list_published_workflows",
      "Show workflows with published packages you can install locally. Never approves or publishes a package.",
      { workflowId: id.optional() },
      async (args) => {
        if (args.workflowId)
          return {
            workflowId: args.workflowId,
            ...((await api.request(
              `/workflows/${encodeURIComponent(args.workflowId)}/publications`,
            )) as object),
          };
        const { workflows } = await api.request<{
          workflows: {
            id: string;
            name: string;
            capabilities: { readPublished: boolean };
          }[];
        }>("/workflows");
        const available = [];
        for (const workflow of workflows.filter(
          (w) => w.capabilities.readPublished,
        )) {
          const { publications } = await api.request<{
            publications: unknown[];
          }>(`/workflows/${encodeURIComponent(workflow.id)}/publications`);
          if (publications.length)
            available.push({
              id: workflow.id,
              name: workflow.name,
              publications,
            });
        }
        return { workflows: available };
      },
      "installPublished",
      true,
    ),
    tool(
      "install_workflow",
      "Preview a published package and Badger MCP installation on this computer. Show every operation and digest to the person. Only after they confirm, repeat with previewId, digest, and confirmed:true. Never signs off service gates.",
      {
        workflowId: id,
        publicationId: id.optional(),
        packageHash: hash.optional(),
        target: target.optional(),
        command: z.string().min(1).max(4096).optional(),
        args: z.array(z.string().max(4096)).max(64).optional(),
        confirmed: z.boolean().optional(),
        previewId: id.optional(),
        digest: hash.optional(),
      },
      async (args) => {
        if (args.confirmed) {
          if (!args.previewId)
            throw new Error("Preview the local installation first");
          return commit(
            args.previewId,
            args.digest,
            args.workflowId,
            "install",
          );
        }
        if (!args.target || !args.publicationId || !args.packageHash)
          throw new Error(
            "Choose the exact publication hash, local host, scope, project root, and home root",
          );
        const publication = {
          workflowId: args.workflowId,
          publicationId: args.publicationId,
          packageHash: args.packageHash,
        };
        const snapshot = await published(publication);
        const plan = await previewInstall({
          target: args.target,
          publication,
          snapshot,
          deploymentUrl: api.url,
          command: args.command,
          args: args.args,
        });
        return {
          ...(await previews.save(plan)),
          requiresLocalConfirmation: true,
          message:
            "Review every operation and digest. Confirm only after the person asks to install this exact preview. Set BADGER_TOKEN in the environment that starts the Agent host.",
        };
      },
      "installPublished",
      false,
    ),
    tool(
      "uninstall_workflow",
      "Preview removal of an owned local workflow package. Protect changed files and other MCP settings. Commit only after the person confirms the returned previewId and digest.",
      {
        workflowId: id,
        target: target.optional(),
        confirmed: z.boolean().optional(),
        previewId: id.optional(),
        digest: hash.optional(),
      },
      async (args) => {
        if (args.confirmed) {
          if (!args.previewId) throw new Error("Preview local removal first");
          return commit(
            args.previewId,
            args.digest,
            args.workflowId,
            "uninstall",
          );
        }
        if (!args.target)
          throw new Error(
            "Choose the local host, scope, project root, and home root",
          );
        const plan = await previewUninstall({
          target: args.target,
          workflowId: args.workflowId,
        });
        await published(plan.preview.publication);
        return {
          ...(await previews.save(plan)),
          requiresLocalConfirmation: true,
        };
      },
      "installPublished",
      false,
    ),
  ];
}
