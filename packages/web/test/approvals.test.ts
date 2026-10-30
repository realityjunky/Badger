import { describe, expect, it } from "vitest";
import {
  approvalHistory,
  type GateConfirmation,
} from "../src/api/workflows.js";

function approval(
  id: string,
  plan: string,
  invalidatedAt: string | null = null,
): GateConfirmation {
  return {
    id,
    actorId: "owner",
    confirmedAt: "2026-10-30T00:00:00.000Z",
    confirmationHash: "0".repeat(64),
    boundHashes: { plan, dossier: "d".repeat(64) },
    invalidatedAt,
    invalidationReason: invalidatedAt ? "The approved dossier changed" : null,
    supersededBy: null,
  };
}

describe("an approval history", () => {
  const history = [
    approval("current", "b".repeat(64)),
    approval("earlier", "a".repeat(64), "2026-10-30T01:00:00.000Z"),
    approval("first", "b".repeat(64), "2026-10-29T00:00:00.000Z"),
  ];

  it("keeps every approval, newest first, and marks invalidated ones superseded", () => {
    expect(
      approvalHistory(history).map((entry) => [entry.id, entry.superseded]),
    ).toEqual([
      ["current", false],
      ["earlier", true],
      ["first", true],
    ]);
  });

  it("keeps only the approvals of the selected artifact", () => {
    expect(
      approvalHistory(history, { name: "plan", hash: "b".repeat(64) }).map(
        (entry) => [entry.id, entry.superseded],
      ),
    ).toEqual([
      ["current", false],
      ["first", true],
    ]);
  });

  it("reads a view without a history as empty", () => {
    expect(approvalHistory(undefined)).toEqual([]);
  });
});
