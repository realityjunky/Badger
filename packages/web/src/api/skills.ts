import { apiUrl } from "../app/paths.js";
import { isRecord } from "../util/records.js";
import type { SkillScriptSideEffect } from "@realityjunky/badger";

export interface SkillFile {
  path: string;
  bytes: number;
  hash: string;
}

export type SideEffect = SkillScriptSideEffect;
export type ScriptEffects = SideEffect[] | "undeclared";

export interface Skill {
  id: string;
  groupId: string;
  name: string;
  canUpload: boolean;
  canRemoveVersion: boolean;
}

export interface SkillGroup {
  id: string;
  name: string;
  canUpload: boolean;
  canCreateSkill: boolean;
  canRemoveVersion: boolean;
}

export interface UploadLimits {
  maxBytes: number;
  maxFileBytes: number;
  maxFiles: number;
}

export interface SkillCatalog {
  skills: Skill[];
  groups: SkillGroup[];
  limits: UploadLimits;
}

export interface VersionPreview {
  hash: string;
  description: string;
  inventory: SkillFile[];
  scripts: { path: string; sideEffects: ScriptEffects }[];
}

export interface SkillVersion extends VersionPreview {
  skillId: string;
  uploadedBy: string;
  createdAt: string;
  label: string | null;
  labelRevision: number;
  retiredAt: string | null;
  origin: "upload" | "git" | "edit";
  gitOrigins: {
    repositoryId: string;
    repository: string;
    commit: string;
    ref: string | null;
  }[];
  editOrigins: {
    baseHash: string;
    method: "browser" | "upload";
    editedBy: string;
    createdAt: string;
  }[];
}

export interface FilePreview {
  path: string;
  bytes: number;
  hash: string;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
}

export interface VersionDiff {
  from: string;
  to: string;
  files: {
    path: string;
    status: "added" | "removed" | "modified";
    before: SkillFile | null;
    after: SkillFile | null;
  }[];
  scripts: {
    path: string;
    before: ScriptEffects | null;
    after: ScriptEffects | null;
  }[];
}

export interface SkillRepository {
  id: string;
  url: string;
}

export interface GitContent {
  repositoryId: string;
  commit: string;
}

export interface UploadContent {
  files?: { path: string; content: string }[];
  archive?: string;
  baseHash?: string;
}

export interface BrowserEditContent {
  baseHash: string;
  changes: { path: string; content: string | null }[];
}

export interface UploadPreview {
  preview: VersionPreview;
  diff?: VersionDiff;
}

export interface SkillVersionRemoval {
  action: "delete" | "retire" | "none";
  referenced: boolean;
}

export class SkillRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload: unknown,
  ) {
    super(message);
  }
}

async function request<T>(
  basePath: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(apiUrl(basePath, path), {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new SkillRequestError(
      response.status,
      isRecord(body) &&
        isRecord(body["error"]) &&
        typeof body["error"]["message"] === "string"
        ? body["error"]["message"]
        : `HTTP ${response.status}`,
      body,
    );
  }
  return body as T;
}

const skillPath = (id: string) => `/skills/${encodeURIComponent(id)}`;
const versionPath = (id: string, hash: string) =>
  `${skillPath(id)}/versions/${encodeURIComponent(hash)}`;

export function versionDownloadUrl(basePath: string, id: string, hash: string) {
  return apiUrl(basePath, `${versionPath(id, hash)}/download`);
}

export function loadSkills(basePath: string, signal?: AbortSignal) {
  return request<SkillCatalog>(basePath, "/skills", { signal });
}

export function createSkill(basePath: string, groupId: string, name: string) {
  return request<{ skill: Skill }>(basePath, "/skills", {
    method: "POST",
    body: JSON.stringify({ groupId, name }),
  });
}

export function loadVersions(
  basePath: string,
  id: string,
  signal?: AbortSignal,
) {
  return request<{ versions: SkillVersion[] }>(
    basePath,
    `${skillPath(id)}/versions`,
    { signal },
  );
}

export function loadFilePreview(
  basePath: string,
  id: string,
  hash: string,
  path: string,
  signal?: AbortSignal,
  mode?: "edit",
) {
  return request<FilePreview>(
    basePath,
    `${versionPath(id, hash)}/files?${new URLSearchParams(mode ? { path, mode } : { path })}`,
    { signal },
  );
}

export function loadDiff(
  basePath: string,
  id: string,
  from: string,
  to: string,
  signal?: AbortSignal,
) {
  return request<VersionDiff>(
    basePath,
    `${skillPath(id)}/diff?${new URLSearchParams({ from, to })}`,
    { signal },
  );
}

export function previewUpload(
  basePath: string,
  id: string,
  content: UploadContent | BrowserEditContent,
  signal?: AbortSignal,
) {
  return request<UploadPreview>(basePath, `${skillPath(id)}/upload-preview`, {
    method: "POST",
    body: JSON.stringify(content),
    signal,
  });
}

/**
 * The first selected path with a segment that names Git metadata: `.git` in
 * any letter case, including with the code points HFS+ ignores or the
 * trailing dots and spaces Windows trims. The service refuses such an
 * upload by the same rule; checking first names the cause even when the
 * folder is also over the upload limits.
 */
export function gitFolderPath(paths: readonly string[]): string | null {
  const gitMetadata = (segment: string) => {
    const name = segment
      .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, "")
      .replace(/[. ]+$/u, "");
    return name.toLowerCase() === ".git" || name.toUpperCase() === ".GIT";
  };
  return paths.find((path) => path.split("/").some(gitMetadata)) ?? null;
}

export function uploadVersion(
  basePath: string,
  id: string,
  content: UploadContent | GitContent | BrowserEditContent,
  expectedHash: string,
) {
  return request<{ version: SkillVersion }>(
    basePath,
    `${skillPath(id)}/versions`,
    {
      method: "POST",
      body: JSON.stringify({
        ...content,
        confirmed: true,
        expectedHash,
      }),
    },
  );
}

export function saveSkillVersionLabel(
  basePath: string,
  id: string,
  hash: string,
  label: string | null,
  revision: number,
) {
  return request<{ version: SkillVersion }>(
    basePath,
    `${versionPath(id, hash)}/label`,
    { method: "PATCH", body: JSON.stringify({ label, revision }) },
  );
}

export function loadRemoval(
  basePath: string,
  id: string,
  hash: string,
  signal?: AbortSignal,
) {
  return request<SkillVersionRemoval>(
    basePath,
    `${versionPath(id, hash)}/removal`,
    { signal },
  );
}

export function removeVersion(
  basePath: string,
  id: string,
  hash: string,
  action: "delete" | "retire",
) {
  return request<{ action: "delete" | "retire"; version: SkillVersion | null }>(
    basePath,
    versionPath(id, hash),
    { method: "DELETE", body: JSON.stringify({ action }) },
  );
}

export function readUploadFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () =>
      reject(new Error("The selected file could not be read"));
    reader.readAsDataURL(file);
  });
}

export function loadRepositories(
  basePath: string,
  id: string,
  signal?: AbortSignal,
) {
  return request<{ repositories: SkillRepository[] }>(
    basePath,
    `${skillPath(id)}/repositories`,
    { signal },
  );
}
export function registerRepository(basePath: string, id: string, url: string) {
  return request<{ repository: SkillRepository }>(
    basePath,
    `${skillPath(id)}/repositories`,
    { method: "POST", body: JSON.stringify({ url }) },
  );
}
export function previewGit(basePath: string, id: string, content: GitContent) {
  return request<{ preview: VersionPreview }>(
    basePath,
    `${skillPath(id)}/git-preview`,
    { method: "POST", body: JSON.stringify(content) },
  );
}
