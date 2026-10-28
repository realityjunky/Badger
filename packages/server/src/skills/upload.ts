import { promises as fs } from "node:fs";
import path from "node:path";
import {
  checkSkillSources,
  readSkillSourceManifest,
  type SkillSource,
  type SkillSourceDeclaration,
} from "@realityjunky/badger";
import type { ServiceConfig } from "../config.js";
import { RequestError, objectInput } from "../http/errors.js";
import { readZipUpload } from "./zip.js";

import { normalizeUploadPath, type UploadFile } from "./paths.js";

export function decodeUploadContent(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(value)
  ) {
    throw new RequestError(400, "File content must be base64");
  }
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value)
    throw new RequestError(400, "File content must be canonical base64");
  return content;
}

export function normalizeUploadFiles(
  files: UploadFile[],
  limits: ServiceConfig["uploads"],
): UploadFile[] {
  if (files.length === 0 || files.length > limits.maxFiles) {
    throw new RequestError(
      413,
      `An upload must contain 1 to ${limits.maxFiles} files`,
    );
  }
  let bytes = 0;
  const paths = new Set<string>();
  const normalized = files.map((file) => {
    const relative = normalizeUploadPath(file.path);
    const key = relative.toLowerCase();
    if (paths.has(key)) throw new RequestError(400, "Duplicate upload paths");
    paths.add(key);
    bytes += file.content.length;
    if (file.content.length > limits.maxFileBytes || bytes > limits.maxBytes) {
      throw new RequestError(
        413,
        "Upload exceeds the file or total byte limit",
      );
    }
    return { path: relative, content: file.content };
  });
  for (const relative of paths) {
    const segments = relative.split("/");
    while (segments.length > 1) {
      segments.pop();
      if (paths.has(segments.join("/")))
        throw new RequestError(400, "A file cannot also be a directory");
    }
  }
  if (!paths.has("skill.md")) {
    const first = normalized[0]?.path.split("/")[0];
    if (
      first !== undefined &&
      normalized.every((file) => file.path.startsWith(`${first}/`))
    ) {
      for (const file of normalized)
        file.path = file.path.slice(first.length + 1);
    }
  }
  if (!normalized.some((file) => file.path === "SKILL.md")) {
    throw new RequestError(400, "Upload one Skill with SKILL.md at its root");
  }
  return normalized;
}

export async function inspectUpload(
  config: ServiceConfig,
  name: string,
  value: unknown,
): Promise<{ source: SkillSource; files: Map<string, Buffer> }> {
  const input = objectInput(value);
  if (
    Object.keys(input).some(
      (key) =>
        !["confirmed", "expectedHash", "files", "archive", "scripts"].includes(
          key,
        ),
    )
  )
    throw new RequestError(400, "Unknown upload field");
  if ((input["files"] !== undefined) === (input["archive"] !== undefined))
    throw new RequestError(400, "Upload either files or one zip archive");
  const folder = input["files"];
  if (folder !== undefined && !Array.isArray(folder))
    throw new RequestError(400, "files must be an array");
  if (Array.isArray(folder) && folder.length > config.uploads.maxFiles)
    throw new RequestError(413, "Upload exceeds the file count limit");
  const files = normalizeUploadFiles(
    Array.isArray(folder)
      ? folder.map((entry: unknown) => {
          const file = objectInput(entry);
          if (
            Object.keys(file).some((key) => !["path", "content"].includes(key))
          ) {
            throw new RequestError(
              400,
              "Only regular files may be uploaded; links are refused",
            );
          }
          return {
            path: normalizeUploadPath(file["path"]),
            content: decodeUploadContent(file["content"]),
          };
        })
      : await readZipUpload(
          decodeUploadContent(input["archive"]),
          config.uploads,
        ),
    config.uploads,
  );
  const workspace = await fs.mkdtemp(
    path.join(config.storage.workspaceDirectory, "skill-upload-"),
  );
  try {
    for (const file of files) {
      const destination = path.join(workspace, "source", file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content, {
        flag: "wx",
        mode: 0o600,
      });
    }
    const declaration: SkillSourceDeclaration = { name, location: "source" };
    if (input["scripts"] !== undefined) {
      const scripts = objectInput(input["scripts"]);
      declaration.scripts = scripts as SkillSourceDeclaration["scripts"];
      const manifest = path.join(workspace, "source-manifest.json");
      await fs.writeFile(
        manifest,
        JSON.stringify({ schemaVersion: 1, sources: [declaration] }),
      );
      try {
        await readSkillSourceManifest(manifest);
      } catch {
        throw new RequestError(
          400,
          "Script side effects must use scripts/ paths and the kernel's supported effects; none stands alone",
        );
      }
    }
    const [candidate] = await checkSkillSources({
      projectRoot: workspace,
      sources: [declaration],
    });
    const source = candidate?.sources[0];
    if (candidate?.status !== "available" || source === undefined) {
      throw new RequestError(
        400,
        "The kernel source check refused this Skill; check its name and SKILL.md frontmatter",
      );
    }
    const scriptPaths = new Set(source.scripts.map((script) => script.path));
    if (
      Object.keys(declaration.scripts ?? {}).some(
        (script) => !scriptPaths.has(script),
      )
    ) {
      throw new RequestError(
        400,
        "Side-effect declarations must name scripts in this version",
      );
    }
    return {
      source,
      files: new Map(files.map((file) => [file.path, file.content])),
    };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
