import type { Queryable } from "./database/database.js";

export interface EvidenceChange {
  skillId: string;
  path: string;
  fromVersionHash: string;
  toVersionHash: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  status: "changed" | "removed" | "unpinned";
}
export interface EvidenceCitation {
  skillId: string;
  versionHash: string;
  path: string;
  fileHash?: string;
}
interface Inventory {
  skill_id: string;
  hash: string;
  inventory: { path: string; hash: string }[];
}

/** Compare immutable file identities, never the containing Skill's version alone. */
export async function evidenceComparison(tx: Queryable, versionId: string) {
  const pins = (
    await tx.query<Inventory>(
      `select s.skill_id, s.hash, s.inventory from workflow_skill_pins p
     join skill_versions s on s.skill_id = p.skill_id and s.hash = p.skill_version_hash
     where p.workflow_version_id = $1`,
      [versionId],
    )
  ).rows;
  const inventories = new Map<string, Inventory["inventory"]>();
  for (const pin of pins)
    inventories.set(`${pin.skill_id}:${pin.hash}`, pin.inventory);
  return async (citations: EvidenceCitation[]): Promise<EvidenceChange[]> => {
    const changes = new Map<string, EvidenceChange>();
    for (const citation of citations) {
      const pin = pins.find((p) => p.skill_id === citation.skillId);
      const key = `${citation.skillId}:${citation.versionHash}`;
      let beforeHash = citation.fileHash;
      if (beforeHash === undefined) {
        if (!inventories.has(key)) {
          const result = await tx.query<Inventory>(
            "select inventory from skill_versions where skill_id = $1 and hash = $2",
            [citation.skillId, citation.versionHash],
          );
          inventories.set(key, result.rows[0]?.inventory ?? []);
        }
        beforeHash = inventories
          .get(key)!
          .find((f) => f.path === citation.path)?.hash;
      }
      const afterHash = pin?.inventory.find(
        (f) => f.path === citation.path,
      )?.hash;
      if (beforeHash !== undefined && beforeHash === afterHash) continue;
      changes.set(`${key}:${citation.path}`, {
        skillId: citation.skillId,
        path: citation.path,
        fromVersionHash: citation.versionHash,
        toVersionHash: pin?.hash ?? null,
        beforeHash: beforeHash ?? null,
        afterHash: afterHash ?? null,
        status:
          pin === undefined
            ? "unpinned"
            : afterHash === undefined
              ? "removed"
              : "changed",
      });
    }
    return [...changes.values()];
  };
}
