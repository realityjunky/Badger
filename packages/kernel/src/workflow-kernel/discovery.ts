import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type {
  SkillCandidate,
  SkillScriptEffect,
  SkillSource,
  SkillSourceDeclaration,
  SkillSourceManifest,
} from "../types.js";
import { SKILL_SCRIPT_SIDE_EFFECTS } from "../types.js";
import { hashSkillInventory, inventorySkill } from "../skill/identity.js";
import { isWithin } from "../util.js";

interface ReadSourceResult {
  source?: SkillSource;
  status: SkillCandidate["status"];
  blocker: string;
}

interface SourceScope {
  lexical: string[];
  physical: string[];
}

function withinAny(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isWithin(root, candidate));
}

async function sourceScope(
  projectRoot: string,
  roots: readonly string[],
): Promise<SourceScope> {
  const lexical = [
    projectRoot,
    ...roots.map((root) => path.resolve(projectRoot, root)),
  ];
  const physical: string[] = [];
  for (const root of lexical)
    physical.push(await fs.realpath(root).catch(() => root));
  return { lexical, physical };
}

interface SkillFrontmatter {
  name: string;
  description: string;
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function declarationLabel(declaration: SkillSourceDeclaration): string {
  return declaration.name || "<unnamed>";
}

function parseFrontmatter(source: string, location: string): SkillFrontmatter {
  const match = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match)
    throw new Error(`${location}: SKILL.md must start with YAML frontmatter`);

  let value: unknown;
  try {
    value = parse(match[1]);
  } catch (error) {
    throw new Error(
      `${location}: SKILL.md frontmatter is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${location}: SKILL.md frontmatter must be a mapping`);

  const metadata = value as Record<string, unknown>;
  if (typeof metadata.name !== "string" || metadata.name.trim().length === 0)
    throw new Error(`${location}: SKILL.md frontmatter requires a name`);
  if (
    typeof metadata.description !== "string" ||
    metadata.description.trim().length === 0
  )
    throw new Error(`${location}: SKILL.md frontmatter requires a description`);

  return { name: metadata.name.trim(), description: metadata.description };
}

async function assertSafeSymlinks(root: string, relative = ""): Promise<void> {
  const entries = await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const target = path.join(root, relative, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = await fs.realpath(target);
      if (!isWithin(root, resolved))
        throw new Error(
          `Skill package symbolic link escapes its root: ${portablePath(
            path.relative(root, target),
          )} -> ${resolved}`,
        );
    } else if (entry.isDirectory()) {
      await assertSafeSymlinks(root, path.join(relative, entry.name));
    }
  }
}

async function readSource(
  declaration: SkillSourceDeclaration,
  projectRoot: string,
  scope: SourceScope,
): Promise<ReadSourceResult> {
  const location = declaration.location.trim();
  if (!location)
    return {
      status: "missing",
      blocker: `Skill ${declarationLabel(declaration)} has an empty source location`,
    };

  const declaredPath = path.resolve(projectRoot, location);
  const relativeLocation = !path.isAbsolute(location);
  if (relativeLocation && !isWithin(projectRoot, declaredPath))
    return {
      status: "unsafe",
      blocker: `Skill ${declarationLabel(
        declaration,
      )} source escapes project root: ${location}`,
    };
  if (
    !relativeLocation &&
    !withinAny(scope.lexical, declaredPath) &&
    !withinAny(scope.physical, declaredPath)
  )
    return {
      status: "unsafe",
      blocker: `Skill ${declarationLabel(
        declaration,
      )} source is outside the project and its registered roots: ${location}`,
    };

  let realRoot: string;
  try {
    realRoot = await fs.realpath(declaredPath);
    if (!(await fs.stat(realRoot)).isDirectory())
      return {
        status: "invalid",
        blocker: `Skill ${declarationLabel(
          declaration,
        )} source is not a directory: ${declaredPath}`,
      };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        status: "missing",
        blocker: `Skill ${declarationLabel(
          declaration,
        )} source path does not exist: ${declaredPath}`,
      };
    return {
      status: "invalid",
      blocker: `Unable to inspect Skill ${declarationLabel(
        declaration,
      )} at ${declaredPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (relativeLocation && !isWithin(projectRoot, realRoot))
    return {
      status: "unsafe",
      blocker: `Skill ${declarationLabel(
        declaration,
      )} source symlink escapes project root: ${declaredPath} -> ${realRoot}`,
    };
  if (!relativeLocation && !withinAny(scope.physical, realRoot))
    return {
      status: "unsafe",
      blocker: `Skill ${declarationLabel(
        declaration,
      )} source resolves outside the project and its registered roots: ${realRoot}`,
    };

  let skillMd: string;
  const skillPath = path.join(realRoot, "SKILL.md");
  try {
    skillMd = await fs.readFile(skillPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        status: "invalid",
        blocker: `Skill ${declarationLabel(
          declaration,
        )} source is missing SKILL.md: ${realRoot}`,
      };
    return {
      status: "invalid",
      blocker: `Unable to read Skill ${declarationLabel(
        declaration,
      )} at ${skillPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const frontmatter = parseFrontmatter(skillMd, skillPath);
    if (frontmatter.name !== declaration.name)
      return {
        status: "invalid",
        blocker: `Skill source ${realRoot} declares name ${frontmatter.name}, not ${declaration.name}`,
      };
    await assertSafeSymlinks(realRoot);
    const inventory = await inventorySkill(realRoot);
    const references = inventory
      .filter(
        (file) =>
          file.path.startsWith("reference/") ||
          file.path.startsWith("references/"),
      )
      .map((file) => ({ path: file.path, contentHash: file.hash }));
    const scripts = inventory
      .filter((file) => file.path.startsWith("scripts/"))
      .map((file) => ({
        path: file.path,
        sideEffect: (declaration.scripts?.[file.path] ??
          "undeclared") as SkillScriptEffect,
      }));
    return {
      source: {
        name: frontmatter.name,
        root: realRoot,
        origin: "explicit",
        description: frontmatter.description,
        skillMd,
        references,
        scripts,
        inventory,
        hash: hashSkillInventory(inventory),
      },
      status: "available",
      blocker: "",
    };
  } catch (error) {
    return {
      status: "invalid",
      blocker: `Invalid Skill package ${realRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function invalidDeclaration(
  declaration: SkillSourceDeclaration,
): ReadSourceResult | undefined {
  if (!declaration || typeof declaration !== "object")
    return {
      status: "invalid",
      blocker:
        "Skill source declaration must be an object with name and location",
    };
  if (
    typeof declaration.name !== "string" ||
    declaration.name.trim().length === 0
  )
    return {
      status: "invalid",
      blocker: "Skill source declaration requires a non-empty name",
    };
  if (typeof declaration.location !== "string")
    return {
      status: "invalid",
      blocker: `Skill ${declaration.name} source declaration requires a location`,
    };
  return undefined;
}

export async function findSkills(options: {
  projectRoot: string;
  sources?: SkillSourceDeclaration[];
  roots?: string[];
}): Promise<SkillCandidate[]> {
  const projectRoot = path.resolve(options.projectRoot);
  const scope = await sourceScope(projectRoot, options.roots ?? []);
  const declarationsByName = new Map<string, SkillSourceDeclaration[]>();
  for (const declaration of options.sources ?? []) {
    const name =
      declaration && typeof declaration.name === "string"
        ? declaration.name.trim()
        : "";
    const group = declarationsByName.get(name) ?? [];
    group.push(declaration);
    declarationsByName.set(name, group);
  }

  const candidates: SkillCandidate[] = [];
  for (const [name, group] of declarationsByName) {
    const blockers: string[] = [];
    const sources: SkillSource[] = [];
    const results: ReadSourceResult[] = [];
    let status: SkillCandidate["status"] = "available";
    for (const declaration of group) {
      const normalizedDeclaration =
        declaration && typeof declaration.name === "string"
          ? { ...declaration, name: declaration.name.trim() }
          : declaration;
      const result =
        invalidDeclaration(declaration) ??
        (await readSource(normalizedDeclaration, projectRoot, scope));
      results.push(result);
      if (result.blocker) blockers.push(result.blocker);
      if (result.source) {
        if (!sources.some((source) => source.root === result.source?.root))
          sources.push(result.source);
      } else if (status === "available") status = result.status;
    }
    if (sources.length > 1) {
      status = "ambiguous";
      blockers.push(
        `Duplicate explicit Skill source declarations for ${name} map to conflicting locations; declare exactly one location`,
        `Skill ${name} resolves to multiple canonical source locations: ${sources
          .map((source) => source.root)
          .join(", ")}`,
      );
    } else if (group.length > 1 && results.some((result) => !result.source)) {
      status = "ambiguous";
      blockers.push(
        `Duplicate explicit Skill source declarations for ${name} include conflicting unresolved locations; declare exactly one location`,
      );
    }
    if (sources.length === 0 && status === "available") status = "missing";
    candidates.push({
      name,
      status,
      sources,
      ...(blockers.length > 0 ? { blockers: [...new Set(blockers)] } : {}),
    });
  }
  return candidates;
}

function isSafeManifestScriptPath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || path.isAbsolute(value))
    return false;
  return !value.replaceAll("\\", "/").split("/").includes("..");
}

function invalidManifest(file: string, reason: string): Error {
  return new Error(`Invalid Skill source manifest: ${file}; ${reason}`);
}

export async function readSkillSourceManifest(
  file: string,
): Promise<SkillSourceManifest> {
  const manifestPath = path.resolve(file);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read Skill source manifest ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).schemaVersion !== 1 ||
    !Array.isArray((value as Record<string, unknown>).sources)
  )
    throw new Error(
      `Invalid Skill source manifest: ${manifestPath}; expected {schemaVersion: 1, sources: [{name, location}]}`,
    );
  const manifest = value as Record<string, unknown>;
  const roots = manifest.roots;
  if (
    roots !== undefined &&
    (!Array.isArray(roots) ||
      roots.some(
        (root) => typeof root !== "string" || root.trim().length === 0,
      ))
  )
    throw invalidManifest(
      manifestPath,
      "roots must be an array of non-empty locations",
    );
  for (const source of manifest.sources as unknown[]) {
    if (!source || typeof source !== "object" || Array.isArray(source))
      throw invalidManifest(
        manifestPath,
        "sources must be objects with name and location",
      );
    const entry = source as Record<string, unknown>;
    if (typeof entry.name !== "string" || typeof entry.location !== "string")
      throw invalidManifest(
        manifestPath,
        "each source requires a name and a location",
      );
    const scripts = entry.scripts;
    if (scripts === undefined) continue;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
      throw invalidManifest(
        manifestPath,
        `source ${entry.name} scripts must map script paths to side effects`,
      );
    for (const [scriptPath, sideEffect] of Object.entries(
      scripts as Record<string, unknown>,
    )) {
      if (!isSafeManifestScriptPath(scriptPath))
        throw invalidManifest(
          manifestPath,
          `source ${entry.name} script path must stay inside the source: ${scriptPath}`,
        );
      if (
        typeof sideEffect !== "string" ||
        !(SKILL_SCRIPT_SIDE_EFFECTS as readonly string[]).includes(sideEffect)
      )
        throw invalidManifest(
          manifestPath,
          `source ${entry.name} script ${scriptPath} has an unknown side effect: ${String(
            sideEffect,
          )}; expected one of ${SKILL_SCRIPT_SIDE_EFFECTS.join(", ")}`,
        );
    }
  }
  return value as SkillSourceManifest;
}

export async function resolveSkillPath(
  selector: string,
  projectRoot: string,
): Promise<SkillSource> {
  const [candidate] = await findSkills({
    projectRoot,
    sources: [{ name: path.basename(selector), location: selector }],
  });
  if (
    !candidate ||
    candidate.status !== "available" ||
    candidate.sources.length !== 1
  )
    throw new Error(
      candidate?.blockers?.join("\n") ??
        `Skill directory not found or invalid Skill package: ${selector}`,
    );
  return candidate.sources[0]!;
}
