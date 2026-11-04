import { describe, expect, it } from "vitest";
import {
  availableSemanticVersion,
  bumpSemanticVersion,
  isSemanticVersion,
  workflowVersionLabel,
} from "../src/util/workflowVersion.js";

describe("workflow version labels", () => {
  it("skips labels already used by other iterations", () => {
    const used = new Set(["1.0.1", "1.0.2", "1.1.0", "2.0.0"]);
    expect(availableSemanticVersion("1.0.0", "patch", used)).toBe("1.0.3");
    expect(availableSemanticVersion("1.0.0", "minor", used)).toBe("1.2.0");
    expect(availableSemanticVersion("1.0.0", "major", used)).toBe("3.0.0");
    expect(used.size).toBe(4);
  });

  it("retains the legacy iteration number when there is no chosen label", () => {
    expect(workflowVersionLabel({ number: 2 })).toBe("v2");
    expect(workflowVersionLabel({ number: 2, semanticVersion: null })).toBe(
      "v2",
    );
    expect(workflowVersionLabel({ number: 2, semanticVersion: "0.2.0" })).toBe(
      "0.2.0",
    );
  });

  it("suggests semantic bumps with exact integer arithmetic", () => {
    expect(bumpSemanticVersion("1.2.9", "patch")).toBe("1.2.10");
    expect(bumpSemanticVersion("1.2.9", "minor")).toBe("1.3.0");
    expect(bumpSemanticVersion("1.2.9", "major")).toBe("2.0.0");
    expect(bumpSemanticVersion("0.0.0", "patch")).toBe("0.0.1");
    expect(bumpSemanticVersion("9007199254740992.0.0", "major")).toBe(
      "9007199254740993.0.0",
    );
    expect(bumpSemanticVersion(`${"9".repeat(60)}.0.0`, "major")).toBeNull();
  });

  it("rejects unsupported formats instead of suggesting an invalid bump", () => {
    for (const label of [
      "",
      "v1.2.3",
      "1.2",
      "1.2.3.4",
      "1.2.3-beta",
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3\n",
      "1.2.3 ",
      "1".repeat(61) + ".0.0",
    ]) {
      expect(isSemanticVersion(label), label).toBe(false);
      expect(bumpSemanticVersion(label, "patch"), label).toBeNull();
    }
    for (const label of ["0.0.0", "0.1.0", "12.34.56", "1".repeat(60) + ".0.0"])
      expect(isSemanticVersion(label), label).toBe(true);
  });
});
