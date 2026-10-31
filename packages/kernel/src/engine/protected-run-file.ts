import { TextDecoder } from "util";

import {
  atomicWriteContainedText,
  inspectProtectedProjectPath,
  readProtectedProjectFile,
  removeContainedFile,
} from "./workflow-contract.js";
import { sameFileObject, type FileObjectIdentity } from "./file-identity.js";
import type {
  RaceSafeReadOptions,
  RaceSafeReadResult,
} from "./race-safe-read.js";

export interface EngineRunReadOptions {
  hooks?: RaceSafeReadOptions["hooks"];
  maxBytes?: number;
  overlay?: EngineRunMutationOverlay;
}

export interface EngineRunWriteOptions {
  beforeCommit?: () => void | Promise<void>;
  exclusive?: boolean;
  maxBytes?: number;
  overlay?: EngineRunMutationOverlay;
}

export interface EngineRunRemoveOptions {
  beforeRemove?: () => void | Promise<void>;
  overlay?: EngineRunMutationOverlay;
}

export interface EngineRunMutationOverlay {
  read(
    relativePath: string,
    maxBytes: number,
    label: string,
  ): Promise<string | null>;
  write(
    relativePath: string,
    content: string,
    maxBytes: number,
    label: string,
  ): Promise<void>;
  remove(relativePath: string, label: string): Promise<boolean>;
}

interface RunFileSnapshot {
  text: string;
  result: RaceSafeReadResult;
}

const MAX_ENGINE_RUN_FILE_BYTES = 16 * 1024 * 1024;

/**
 * The fresh reads a reader makes of a Run record that a writer keeps
 * replacing. A transition replaces a record once as it commits, and once more
 * when recovery rolls it forward, so these outlast several transitions.
 */
export const ENGINE_RUN_RECORD_READ_ATTEMPTS = 8;

function boundedMaxBytes(
  requested: number | undefined,
  fallback: number,
  label: string,
): number {
  const value = requested ?? fallback;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ENGINE_RUN_FILE_BYTES
  ) {
    throw new Error(`${label} size bound is invalid`);
  }
  return value;
}

function identityOf(stat: RaceSafeReadResult["stat"]): FileObjectIdentity {
  return { dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs };
}

function decodeRunText(result: RaceSafeReadResult, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

async function readSnapshot(
  changeDir: string,
  relativePath: string,
  maxBytes: number,
  label: string,
  options: EngineRunReadOptions = {},
): Promise<RunFileSnapshot | null> {
  const effectiveMaxBytes = boundedMaxBytes(options.maxBytes, maxBytes, label);
  try {
    const result = await readProtectedProjectFile(
      changeDir,
      relativePath,
      effectiveMaxBytes,
      {
        label,
        hooks: options.hooks,
      },
    );
    return { result, text: decodeRunText(result, label) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

export async function readOptionalEngineRunText(
  changeDir: string,
  relativePath: string,
  maxBytes: number,
  label: string,
  options: EngineRunReadOptions = {},
): Promise<string | null> {
  if (options.overlay) {
    return options.overlay.read(
      relativePath,
      options.maxBytes ?? maxBytes,
      label,
    );
  }
  return (
    (await readSnapshot(changeDir, relativePath, maxBytes, label, options))
      ?.text ?? null
  );
}

export async function writeEngineRunText(
  changeDir: string,
  relativePath: string,
  content: string,
  maxBytes: number,
  label: string,
  options: EngineRunWriteOptions = {},
): Promise<void> {
  const effectiveMaxBytes = boundedMaxBytes(options.maxBytes, maxBytes, label);
  if (Buffer.byteLength(content, "utf8") > effectiveMaxBytes) {
    throw new Error(`${label} exceeds ${effectiveMaxBytes} bytes`);
  }
  if (options.overlay) {
    await options.overlay.write(
      relativePath,
      content,
      effectiveMaxBytes,
      label,
    );
    return;
  }
  const expected = await readSnapshot(
    changeDir,
    relativePath,
    effectiveMaxBytes,
    label,
    options,
  );
  const inspection = await inspectProtectedProjectPath(
    changeDir,
    relativePath,
    {
      label,
      expected: "file",
    },
  );
  await atomicWriteContainedText(inspection.target, content, {
    containedRoot: inspection.projectRoot,
    exclusive: options.exclusive,
    beforeCommit: async () => {
      await options.beforeCommit?.();
      const current = await readSnapshot(
        changeDir,
        relativePath,
        effectiveMaxBytes,
        label,
      );
      if (!expected && !current) return;
      if (!expected || !current) {
        const error = new Error(
          `${label} changed before commit`,
        ) as NodeJS.ErrnoException;
        if (options.exclusive && !expected && current) error.code = "EEXIST";
        throw error;
      }
      if (
        expected.result.realPath !== current.result.realPath ||
        !sameFileObject(
          identityOf(expected.result.stat),
          identityOf(current.result.stat),
        ) ||
        expected.text !== current.text
      ) {
        throw new Error(`${label} changed before commit`);
      }
    },
  });
}

export async function appendEngineRunText(
  changeDir: string,
  relativePath: string,
  addition: string,
  maxBytes: number,
  label: string,
  options: EngineRunWriteOptions = {},
): Promise<void> {
  const existing = await readOptionalEngineRunText(
    changeDir,
    relativePath,
    maxBytes,
    label,
    options,
  );
  await writeEngineRunText(
    changeDir,
    relativePath,
    `${existing ?? ""}${addition}`,
    maxBytes,
    label,
    options,
  );
}

export async function removeEngineRunFile(
  changeDir: string,
  relativePath: string,
  label: string,
  options: EngineRunRemoveOptions = {},
): Promise<boolean> {
  if (options.overlay) {
    return options.overlay.remove(relativePath, label);
  }
  const inspection = await inspectProtectedProjectPath(
    changeDir,
    relativePath,
    {
      label,
      expected: "file",
    },
  );
  if (!inspection.exists) return false;
  return removeContainedFile(inspection.target, {
    containedRoot: inspection.projectRoot,
    beforeRemove: options.beforeRemove,
  });
}
