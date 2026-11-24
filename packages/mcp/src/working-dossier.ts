import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalHash,
  readProtectedProjectFile,
  type SkillSourceFile,
  type WorkingDossierJob,
  type WorkingDossierView,
} from "@realityjunky/badger";
import {
  BadgerApiError,
  isRateLimitedBadgerFailure,
  type BadgerApi,
} from "./api.js";
import { safePath, writePrivateSourceFile } from "./jobs.js";
import { questionnairePath } from "./tools.js";

interface WorkflowVersion {
  workflowId: string;
  versionId: string;
}

interface SourceInput extends WorkflowVersion {
  pinsHash: string;
  localSourceRoot?: string;
  localSkillRoots?: Record<string, string>;
}

interface MaterializedFile extends SkillSourceFile {
  skillId: string;
  localPath: string;
  source: "local" | "badger";
}

interface PinnedFileRange extends SkillSourceFile {
  skillId: string;
  offset: number;
  content: string;
}

interface FileRange {
  file: MaterializedFile;
  offset: number;
  size: number;
}

interface SourceDownload {
  folder: string;
  files: MaterializedFile[];
  batches: Generator<FileRange[], undefined>;
  nextBatch: FileRange[] | undefined;
  parts: Buffer[];
}

const CHUNK_BYTES = 256 * 1024;
const BATCH_BYTES = 4 * CHUNK_BYTES;
const BATCH_FILES = 32;
const MAX_EDIT_BYTES = 512 * 1024;

function dossierPath(input: WorkflowVersion) {
  return `/workflows/${encodeURIComponent(input.workflowId)}/versions/${encodeURIComponent(input.versionId)}/working-dossier`;
}

export async function readWorkingDossierJob(
  api: BadgerApi,
  input: WorkflowVersion,
) {
  const job = await api.request<WorkingDossierJob>(`${dossierPath(input)}/job`);
  return { ...job, reviewUrl: new URL(job.reviewUrl, `${api.url}/`).href };
}

export async function readDossierReadiness(
  api: BadgerApi,
  input: WorkflowVersion,
) {
  const dossier = await api
    .request<WorkingDossierView>(dossierPath(input))
    .catch((error: unknown) => {
      if (error instanceof BadgerApiError && error.status === 404) return null;
      throw error;
    });
  if (dossier && !dossier.legacy && (dossier.available || dossier.revision > 0))
    return {
      revision: dossier.revision,
      pinsHash: dossier.pinsHash,
      readiness: dossier.readiness,
    };
  const { handoff } = await api.request<{ handoff: { readiness: unknown } }>(
    `${questionnairePath(input)}/ledger`,
  );
  return { readiness: handoff.readiness };
}

function hashMatches(file: SkillSourceFile, bytes: Buffer) {
  return (
    bytes.length === file.bytes &&
    createHash("sha256").update(bytes).digest("hex") === file.hash
  );
}

function* fileBatches(
  files: MaterializedFile[],
): Generator<FileRange[], undefined> {
  let batch: FileRange[] = [];
  let total = 0;
  for (const file of files) {
    for (
      let offset = 0;
      offset < Math.max(1, file.bytes);
      offset += CHUNK_BYTES
    ) {
      const size = Math.min(CHUNK_BYTES, file.bytes - offset);
      if (batch.length === BATCH_FILES || total + size > BATCH_BYTES) {
        yield batch;
        batch = [];
        total = 0;
      }
      batch.push({ file, offset, size });
      total += size;
    }
  }
  if (batch.length > 0) yield batch;
}

export class LocalWorkingDossiers {
  private readonly folders = new Map<
    string,
    WorkflowVersion & { pinsHash: string }
  >();
  private readonly preparing = new Map<string, Promise<unknown>>();
  private readonly resumable = new Map<string, SourceDownload>();
  private closing: Promise<void> | undefined;

  constructor(private readonly api: BadgerApi) {}

  sources(input: SourceInput) {
    if (this.closing) throw new Error("The MCP connection is closed");
    const key = canonicalHash(input);
    const active = this.preparing.get(key);
    if (active) return active;
    const prepared = this.prepareSources(input, key).finally(() =>
      this.preparing.delete(key),
    );
    this.preparing.set(key, prepared);
    return prepared;
  }

  private async prepareSources(input: SourceInput, key: string) {
    let download = this.resumable.get(key);
    try {
      const job = await readWorkingDossierJob(this.api, input);
      if (input.pinsHash !== job.dossier.pinsHash)
        throw new Error(
          "The pin set changed. Read the current working dossier job.",
        );
      if (this.closing) throw new Error("The MCP connection is closed");
      download ??= await this.resolveLocalFiles(input, job);
      await this.downloadFiles(input, download);
      if (this.closing) throw new Error("The MCP connection is closed");
      this.resumable.delete(key);
      const { folder, files } = download;
      this.folders.set(folder, {
        workflowId: input.workflowId,
        versionId: input.versionId,
        pinsHash: input.pinsHash,
      });
      return { folder, pinsHash: input.pinsHash, files };
    } catch (error) {
      if (isRateLimitedBadgerFailure(error) && !this.closing) {
        if (download) this.resumable.set(key, download);
        throw new Error(
          `${error.message} Retry the same source request to resume.`,
          { cause: error },
        );
      }
      this.resumable.delete(key);
      if (download)
        await fs
          .rm(download.folder, { recursive: true, force: true })
          .catch(() => undefined);
      throw error;
    }
  }

  private async resolveLocalFiles(
    input: SourceInput,
    job: WorkingDossierJob,
  ): Promise<SourceDownload> {
    const folder = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-working-dossier-"),
    );
    try {
      await fs.chmod(folder, 0o700);
      const files: MaterializedFile[] = [];
      for (const pin of job.pins) {
        for (const entry of pin.inventory) {
          const relative = safePath(`${pin.skillId}/${pin.hash}/${entry.path}`);
          const file: MaterializedFile = {
            ...entry,
            skillId: pin.skillId,
            localPath: path.join(folder, "skills", relative),
            source: "badger",
          };
          files.push(file);
          const explicitRoot = input.localSkillRoots?.[pin.skillId];
          const root = explicitRoot ?? input.localSourceRoot;
          if (!root) continue;
          const filename = explicitRoot
            ? entry.path
            : `${pin.name}/${entry.path}`;
          const local = await readProtectedProjectFile(
            root,
            safePath(filename),
            Math.max(1, entry.bytes),
            {
              label: "Local pinned Skill file",
            },
          ).catch(() => undefined);
          if (local && hashMatches(entry, local.bytes)) {
            await writePrivateSourceFile(file.localPath, local.bytes);
            file.source = "local";
          }
        }
      }
      const batches = fileBatches(
        files.filter(({ source }) => source === "badger"),
      );
      return {
        folder,
        files,
        batches,
        nextBatch: batches.next().value,
        parts: [],
      };
    } catch (error) {
      await fs
        .rm(folder, { recursive: true, force: true })
        .catch(() => undefined);
      throw error;
    }
  }

  private async downloadFiles(input: SourceInput, download: SourceDownload) {
    while (download.nextBatch) {
      const batch = download.nextBatch;
      if (this.closing) throw new Error("The MCP connection is closed");
      const { files } = await this.api.request<{ files: PinnedFileRange[] }>(
        `${dossierPath(input)}/files`,
        "POST",
        {
          pinsHash: input.pinsHash,
          files: batch.map(({ file, offset, size }) => ({
            skillId: file.skillId,
            path: file.path,
            offset,
            length: Math.max(1, size),
          })),
        },
      );
      if (!Array.isArray(files) || files.length !== batch.length)
        throw new Error(
          "Badger returned an incomplete batch of pinned Skill files",
        );
      for (const [index, { file, offset, size }] of batch.entries()) {
        const part = files[index];
        if (
          part?.skillId !== file.skillId ||
          part.path !== file.path ||
          part.hash !== file.hash ||
          part.bytes !== file.bytes ||
          part.offset !== offset ||
          typeof part.content !== "string" ||
          part.content.length !== Math.ceil(size / 3) * 4
        )
          throw new Error(
            "A downloaded Skill file range does not match the job inventory",
          );
        const bytes = Buffer.from(part.content, "base64");
        if (bytes.length !== size)
          throw new Error(
            "A downloaded Skill file range does not match its requested size",
          );
        download.parts.push(bytes);
        if (offset + size === file.bytes) {
          const content = Buffer.concat(download.parts, file.bytes);
          if (!hashMatches(file, content))
            throw new Error(
              "A downloaded Skill file does not match its pinned hash",
            );
          await writePrivateSourceFile(file.localPath, content);
          download.parts = [];
        }
      }
      download.nextBatch = download.batches.next().value;
    }
  }

  async save(
    input: WorkflowVersion & {
      edit?: Record<string, unknown>;
      folder?: string;
    },
  ) {
    if ((input.edit === undefined) === (input.folder === undefined))
      throw new Error("Supply either an edit or a folder containing edit.json");
    const edit =
      input.folder === undefined
        ? input.edit
        : await this.readEdit(input, path.resolve(input.folder));
    if (Buffer.byteLength(JSON.stringify(edit)) > MAX_EDIT_BYTES)
      throw new Error(
        "The working dossier edit exceeds 512 KiB. Split it into smaller saves.",
      );
    const { revision, savedRevision, pinsHash, reviewUrl } =
      await this.api.request<WorkingDossierView>(
        dossierPath(input),
        "PATCH",
        edit,
      );
    return {
      revision,
      savedRevision,
      pinsHash,
      reviewUrl: new URL(reviewUrl, `${this.api.url}/`).href,
    };
  }

  private async readEdit(input: WorkflowVersion, folder: string) {
    const source = this.folders.get(folder);
    if (
      source?.workflowId !== input.workflowId ||
      source.versionId !== input.versionId
    )
      throw new Error(
        "Supply the folder returned by working_dossier_sources for this workflow version on this MCP connection",
      );
    const { bytes } = await readProtectedProjectFile(
      folder,
      "edit.json",
      MAX_EDIT_BYTES,
      {
        label: "Working dossier edit.json",
      },
    );
    let edit: unknown;
    try {
      edit = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Write a valid JSON edit to edit.json");
    }
    if (
      !edit ||
      typeof edit !== "object" ||
      !("pinsHash" in edit) ||
      edit.pinsHash !== source.pinsHash
    )
      throw new Error("Use the pin set from this folder's working dossier job");
    return edit;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.allSettled(this.preparing.values());
      await Promise.allSettled(
        [
          ...this.folders.keys(),
          ...[...this.resumable.values()].map(({ folder }) => folder),
        ].map((folder) => fs.rm(folder, { recursive: true, force: true })),
      );
      this.folders.clear();
      this.resumable.clear();
    })();
    return this.closing;
  }
}
