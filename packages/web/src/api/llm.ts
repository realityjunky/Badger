import type { LlmConfiguration } from "@realityjunky/badger-server";
import { apiUrl } from "../app/paths.js";
import { isRecord } from "../util/records.js";
export type {
  LlmConfiguration,
  ModelConnection,
  ModelSetting,
  SettingValue,
} from "@realityjunky/badger-server";

export interface LlmSettings {
  revision: number;
  hash: string;
  configuration: LlmConfiguration;
  fileConfigured: boolean;
  secretStorageConfigured: boolean;
  credentials: Record<string, { configured: boolean }>;
}
export type SecretChange =
  { action: "replace"; value: string } | { action: "clear" };

async function request<T>(
  basePath: string,
  suffix: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(apiUrl(basePath, `/admin/llm${suffix}`), {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      isRecord(value) &&
        isRecord(value.error) &&
        typeof value.error.message === "string"
        ? value.error.message
        : `HTTP ${response.status}`,
    );
  return value as T;
}
export const loadLlm = (basePath: string, signal?: AbortSignal) =>
  request<LlmSettings>(basePath, "", { signal });
export const saveLlm = (
  basePath: string,
  revision: number,
  configuration: LlmConfiguration,
  secrets: Record<string, SecretChange>,
) =>
  request<LlmSettings>(basePath, "", {
    method: "PUT",
    body: JSON.stringify({ revision, configuration, secrets }),
  });
export const reloadLlm = (basePath: string, revision: number) =>
  request<LlmSettings>(basePath, "/reload", {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
export const testLlm = (basePath: string, revision: number, modelId: string) =>
  request<{ message: string }>(basePath, "/test", {
    method: "POST",
    body: JSON.stringify({ revision, modelId }),
  });
