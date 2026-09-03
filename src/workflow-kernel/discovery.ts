import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import type { SkillCandidate, SkillSource } from "../types.js";
import { hashDirectory } from "./hash.js";
import { isWithin, sha256 } from "../util.js";

export type SkillPreferencePolicy = "strict";

export interface PreferenceEntry {
  query: string;
  preferenceIndex: number | null;
}

export interface SearchRoot {
  root: string;
  origin: SkillSource["origin"];
}

function looksLikePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function parseDescription(source: string): string {
  const match = source.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return "";
  try {
    const value = parse(match[1]) as Record<string, unknown>;
    return typeof value?.description === "string" ? value.description : "";
  } catch {
    return "";
  }
}

async function optionalFiles(
  root: string,
  directory: string,
): Promise<Array<{ path: string; hash: string }>> {
  const target = path.join(root, directory);
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const result: Array<{ path: string; hash: string }> = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) {
        result.push(
          ...(await optionalFiles(root, path.join(directory, entry.name))),
        );
      } else if (entry.isFile()) {
        result.push({
          path: path.relative(root, child).split(path.sep).join("/"),
          hash: sha256(await fs.readFile(child)),
        });
      }
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readSource(
  name: string,
  root: SearchRoot,
): Promise<SkillSource | null> {
  const candidate = path.resolve(root.root, name);
  if (!isWithin(root.root, candidate)) return null;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(candidate);
    if (!isWithin(await fs.realpath(root.root), realRoot)) return null;
    if (!(await fs.stat(realRoot)).isDirectory()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let skillMd: string;
  try {
    skillMd = await fs.readFile(path.join(realRoot, "SKILL.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const references = [
    ...(await optionalFiles(realRoot, "reference")),
    ...(await optionalFiles(realRoot, "references")),
  ]
    .map((item) => ({ path: item.path, contentHash: item.hash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const scripts = (await optionalFiles(realRoot, "scripts"))
    .map((item) => ({ path: item.path, sideEffect: "unknown" as const }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    name,
    root: realRoot,
    origin: root.origin,
    description: parseDescription(skillMd),
    skillMd,
    references,
    scripts,
    hash: await hashDirectory(realRoot),
  };
}

function defaultRoots(projectRoot: string, homeDir: string): SearchRoot[] {
  return [
    { root: path.join(projectRoot, ".badger", "skills"), origin: "project" },
    { root: path.join(projectRoot, ".agents", "skills"), origin: "project" },
    { root: path.join(projectRoot, ".codex", "skills"), origin: "project" },
    { root: path.join(homeDir, ".agents", "skills"), origin: "global" },
    { root: path.join(homeDir, ".codex", "skills"), origin: "global" },
  ];
}

function preferenceFile(projectRoot: string, stateNamespace: string): string {
  return path.join(projectRoot, stateNamespace, "skill-preferences.yaml");
}

export async function readPreferenceEntries(
  projectRoot: string,
  stateNamespace = ".badger",
): Promise<PreferenceEntry[]> {
  const file = preferenceFile(projectRoot, stateNamespace);
  try {
    const value = parse(await fs.readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    if (!value || value.version !== 1 || !Array.isArray(value.prefer))
      throw new Error(`${file}: expected version: 1 and prefer: []`);
    if (value.policy !== undefined && value.policy !== "strict")
      throw new Error(
        `${file}: only the strict preference policy is supported`,
      );
    return value.prefer
      .filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
      .map((query, preferenceIndex) => ({ query, preferenceIndex }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function findSkills(options: {
  projectRoot: string;
  homeDir?: string;
  preferences?: PreferenceEntry[];
  extraRoots?: SearchRoot[];
  stateNamespace?: string;
  preferencePolicy?: SkillPreferencePolicy;
}): Promise<SkillCandidate[]> {
  if (options.preferencePolicy && options.preferencePolicy !== "strict")
    throw new Error("Only the strict preference policy is supported");
  const projectRoot = path.resolve(options.projectRoot);
  const roots = [
    ...defaultRoots(projectRoot, path.resolve(options.homeDir ?? os.homedir())),
    ...(options.extraRoots ?? []),
  ];
  const preferences =
    options.preferences ??
    (await readPreferenceEntries(
      projectRoot,
      options.stateNamespace ?? ".badger",
    ));
  const queries = preferences.length
    ? preferences
    : await discoveredQueries(roots);
  const results: SkillCandidate[] = [];
  for (const entry of queries) {
    const explicit = looksLikePath(entry.query)
      ? await readSource(
          path.basename(path.resolve(projectRoot, entry.query)),
          {
            root: path.dirname(path.resolve(projectRoot, entry.query)),
            origin: "explicit",
          },
        )
      : null;
    const sources = explicit
      ? [explicit]
      : (
          await Promise.all(roots.map((root) => readSource(entry.query, root)))
        ).filter((item): item is SkillSource => item !== null);
    const unique = [
      ...new Map(sources.map((source) => [source.root, source])).values(),
    ];
    results.push({
      query: entry.query,
      preferenceIndex: entry.preferenceIndex,
      status:
        unique.length === 0
          ? "missing"
          : unique.length === 1
            ? "available"
            : "ambiguous",
      sources: unique,
    });
  }
  return results;
}

async function discoveredQueries(
  roots: SearchRoot[],
): Promise<PreferenceEntry[]> {
  const names = new Set<string>();
  for (const root of roots) {
    try {
      for (const entry of await fs.readdir(root.root, { withFileTypes: true }))
        if (
          entry.isDirectory() &&
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name)
        )
          names.add(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...names]
    .sort()
    .map((query, preferenceIndex) => ({ query, preferenceIndex }));
}

export async function resolveSkillPath(
  selector: string,
  projectRoot: string,
): Promise<SkillSource> {
  const target = path.resolve(projectRoot, selector);
  const source = await readSource(path.basename(target), {
    root: path.dirname(target),
    origin: "explicit",
  });
  if (!source)
    throw new Error(`Skill directory not found or missing SKILL.md: ${target}`);
  return source;
}
