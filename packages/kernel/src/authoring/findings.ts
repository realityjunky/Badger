import { canonicalHash } from "../util.js";
import type { AuthoringLaneFinding, AuthoringPlan } from "./types.js";

export const findingRoutes = [
  "plan",
  "implementation",
  "verification",
  "lane",
  "question",
  "sources",
  "dossier",
  "proposal",
  "badger",
] as const;
export type FindingRoute = (typeof findingRoutes)[number];
export interface FindingDisposition {
  sourceSkillId?: string;
  environment?: string;
  dependsOn?: string[];
  due?: "assembly" | "review" | "run";
  verifier?: { nodeId: string; requirementId: string };
  subject: string;
  route: FindingRoute;
  target: string;
  acceptance: string;
  authority: string;
  findingId?: string;
}

export function parseFindingDisposition(value: unknown): FindingDisposition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A finding disposition must be an object");
  const item = value as Record<string, unknown>;
  if (
    !findingRoutes.includes(item.route as FindingRoute) ||
    Object.keys(item).some(
      (key) =>
        ![
          "subject",
          "sourceSkillId",
          "environment",
          "dependsOn",
          "route",
          "target",
          "acceptance",
          "authority",
          "findingId",
          "due",
          "verifier",
        ].includes(key),
    )
  )
    throw new Error("Choose a supported finding disposition");
  for (const key of ["subject", "target", "acceptance", "authority"]) {
    const field = item[key];
    if (
      typeof field !== "string" ||
      !field.trim() ||
      field.length > (key === "subject" ? 200 : 4000)
    )
      throw new Error(
        "A finding needs a bounded subject, target, acceptance example and governing authority",
      );
  }
  if (
    item.findingId !== undefined &&
    (typeof item.findingId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(item.findingId))
  )
    throw new Error("Invalid existing finding ID");
  if (
    item.due !== undefined &&
    !["assembly", "review", "run"].includes(String(item.due))
  )
    throw new Error("Unknown finding evidence stage");
  const verifier = item.verifier as FindingDisposition["verifier"];
  if (
    item.environment !== undefined &&
    (typeof item.environment !== "string" ||
      !item.environment.trim() ||
      item.environment.length > 4000)
  )
    throw new Error(
      "Name the installation and relevant tool versions to check",
    );
  if (
    item.sourceSkillId !== undefined &&
    (typeof item.sourceSkillId !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(item.sourceSkillId))
  )
    throw new Error("Choose a pinned package Skill");
  if (
    item.dependsOn !== undefined &&
    (!Array.isArray(item.dependsOn) ||
      item.dependsOn.length > 32 ||
      item.dependsOn.some(
        (id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id),
      ) ||
      new Set(item.dependsOn).size !== item.dependsOn.length)
  )
    throw new Error("Select distinct findings as prerequisites");
  if (
    item.verifier !== undefined &&
    (!verifier ||
      typeof verifier !== "object" ||
      Object.keys(verifier).length !== 2 ||
      ![verifier.nodeId, verifier.requirementId].every(
        (id) => typeof id === "string" && /^[\w.-]{1,200}$/.test(id),
      ))
  )
    throw new Error("Choose an exact protocol Node and verifier requirement");
  return {
    subject: (item.subject as string).trim(),
    route: item.route as FindingRoute,
    target: (item.target as string).trim(),
    acceptance: (item.acceptance as string).trim(),
    authority: (item.authority as string).trim(),
    ...(typeof item.environment === "string" && {
      environment: item.environment.trim(),
    }),
    ...(typeof item.sourceSkillId === "string"
      ? { sourceSkillId: item.sourceSkillId }
      : {}),
    ...(Array.isArray(item.dependsOn) && item.dependsOn.length
      ? { dependsOn: [...item.dependsOn].sort() }
      : {}),
    ...(item.due !== undefined
      ? { due: item.due as FindingDisposition["due"] }
      : {}),
    ...(verifier
      ? {
          verifier: {
            nodeId: verifier.nodeId,
            requirementId: verifier.requirementId,
          },
        }
      : {}),
    ...(item.findingId ? { findingId: item.findingId as string } : {}),
  };
}

export function findingSubjectKey(disposition: FindingDisposition): string {
  return canonicalHash({
    subject: disposition.subject,
    target: disposition.target,
    route: disposition.route,
    ...(disposition.sourceSkillId && {
      sourceSkillId: disposition.sourceSkillId,
    }),
  });
}

export function findingVerificationState(input: {
  dismissed: boolean;
  reviewed: boolean;
  adoptedHash: string | null;
  currentHash: string | null;
  verifiedHash: string | null;
  verifierCurrent?: boolean;
}) {
  if (input.dismissed) return "not-applicable";
  if (input.verifiedHash)
    return input.currentHash === input.verifiedHash &&
      input.verifierCurrent !== false
      ? "verified"
      : "recheck";
  if (input.adoptedHash)
    return input.adoptedHash === input.currentHash
      ? "awaiting-evidence"
      : "recheck";
  return input.reviewed ? "open" : "suggested";
}

export function readyPlanFinding(finding: AuthoringLaneFinding) {
  const work = finding.disposition;
  return (
    work?.route === "plan" &&
    work.target.startsWith("/") &&
    !work.dependsOn?.length &&
    !!work.authority &&
    !!finding.fix?.trim()
  );
}

/** Existing field or named insertion under an existing parent in the approved Plan. */
export function planFindingTargetHash(plan: unknown, target: string) {
  if (!target.startsWith("/") || /~(?![01])/.test(target)) return null;
  const keys = target
    .slice(1)
    .split("/")
    .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current = plan;
  for (const [index, key] of keys.entries()) {
    if (!key || !current || typeof current !== "object") return null;
    const last = index === keys.length - 1;
    if (
      Array.isArray(current) &&
      !(last && key === "-") &&
      (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > current.length)
    )
      return null;
    if (!Object.hasOwn(current, key))
      return last ? canonicalHash({ insert: key }) : null;
    current = (current as Record<string, unknown>)[key];
  }
  return canonicalHash({ value: current });
}

/** Resolve a reviewed target using the same generated claims and leaves the lane may author. */
export function findingTargetLane(plan: AuthoringPlan, target: string) {
  return plan.lanes.find(
    (lane) =>
      lane.id === target ||
      lane.contentLeaves.includes(target) ||
      lane.claims.includes(target) ||
      lane.derivedClaims.includes(target),
  )?.id;
}

export interface PackageFileChange {
  path: string;
  previousHash: string | null;
  content: string | null;
}
export interface PackageImplementationFile {
  path: string;
  content: string;
}

export function inPackageImplementationScope(target: string, path: string) {
  return target.endsWith("/") ? path.startsWith(target) : path === target;
}

export function validatePackageImplementationFiles(
  files: readonly PackageImplementationFile[],
) {
  if (
    files.length > 256 ||
    files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) >
      8 * 1024 * 1024
  )
    throw new Error("Package implementation exceeds 256 files or 8 MiB");
  const paths = new Set<string>();
  const directories = new Set<string>();
  for (const file of files) {
    const key = packageImplementationPath(file.path).toLowerCase();
    if (paths.has(key) || directories.has(key))
      throw new Error("Conflicting package implementation paths");
    paths.add(key);
    const parts = key.split("/");
    while (parts.length > 1) {
      parts.pop();
      const directory = parts.join("/");
      if (paths.has(directory))
        throw new Error("An implementation file cannot also be a directory");
      directories.add(directory);
    }
  }
}

export function findingBlocksGate(
  disposition: FindingDisposition | null,
  reviewed: boolean,
  status: string,
  gate: "assembly" | "review",
) {
  if (
    !reviewed ||
    !disposition ||
    ["verified", "not-applicable"].includes(status)
  )
    return false;
  const due = disposition.due ?? "assembly";
  return due === "assembly" || due === gate;
}

export function packageImplementationPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 400 ||
    !/^implementation\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
      value,
    ) ||
    value
      .split("/")
      .some(
        (part) =>
          part.length > 255 ||
          /[.]$|^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error(
      "Choose a portable file path below this package's implementation/ directory",
    );
  return value;
}
