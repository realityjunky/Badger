/**
 * Legacy immutable artifacts stay in storage under their original hashes.
 * Readers get a portable projection, never the old server's source paths.
 * A projection cannot stand in for the originally approved canonical bytes.
 */
export function portableAuthoringHistory<T>(value: T) {
  const snapshot = structuredClone(value);
  let legacy = false;
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.kind === "semantic-dossier" && Array.isArray(object.sources)) {
      for (const source of object.sources) {
        if (
          source !== null &&
          typeof source === "object" &&
          "canonicalPath" in source
        ) {
          delete source.canonicalPath;
          legacy = true;
        }
      }
    }
    Object.values(object).forEach(visit);
  };
  visit(snapshot);
  return { snapshot, legacy };
}

export function publicAuthoringVersion<
  T extends { canonicalJson: string; snapshot: unknown },
>(
  version: T,
): Omit<T, "canonicalJson"> & {
  canonicalJson: string | null;
  requiresRecomposition?: true;
} {
  const { snapshot, legacy } = portableAuthoringHistory(version.snapshot);
  return legacy
    ? { ...version, snapshot, canonicalJson: null, requiresRecomposition: true }
    : version;
}
