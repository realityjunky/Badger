export function workflowVersionLabel(version: {
  number: number;
  semanticVersion?: string | null;
}): string {
  return version.semanticVersion ?? `v${version.number}`;
}

export function isSemanticVersion(value: string): boolean {
  return (
    value.length <= 64 &&
    value === value.trim() &&
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(value)
  );
}

export function bumpSemanticVersion(
  value: string,
  bump: "patch" | "minor" | "major",
): string | null {
  if (!isSemanticVersion(value)) return null;
  const [major, minor, patch] = value.split(".").map(BigInt) as [
    bigint,
    bigint,
    bigint,
  ];
  const next =
    bump === "major"
      ? `${major + 1n}.0.0`
      : bump === "minor"
        ? `${major}.${minor + 1n}.0`
        : `${major}.${minor}.${patch + 1n}`;
  return isSemanticVersion(next) ? next : null;
}

export function availableSemanticVersion(
  value: string,
  bump: "patch" | "minor" | "major",
  used: ReadonlySet<string>,
): string | null {
  let next = bumpSemanticVersion(value, bump);
  while (next !== null && used.has(next))
    next = bumpSemanticVersion(next, bump);
  return next;
}
