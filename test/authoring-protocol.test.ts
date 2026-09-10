import { describe, expect, it } from "vitest";
import {
  AUTHORING_PROTOCOL,
  AUTHORING_PROTOCOL_HASH,
  authoringAffectedLanes,
  authoringContentLeaves,
  authoringContentLeafOwners,
  authoringDependencyClosure,
  authoringDependentLanes,
  authoringLaneClaimIds,
  authoringLaneContentLeaves,
  authoringLaneDependencies,
  authoringLaneIds,
  authoringLaneProjection,
  authoringLaneWave,
  authoringLanesForWave,
  authoringProtocolProjection,
  hashAuthoringProtocol,
  validateAuthoringProtocol,
} from "../src/authoring/index.js";

describe("AuthoringProtocol projections", () => {
  it("exposes the canonical six-lane waves and dependency closure", () => {
    expect(authoringLaneIds()).toEqual([
      "script",
      "reference",
      "pause-points",
      "workflow-entry",
      "skill-core",
      "skill-review",
    ]);
    expect(authoringLanesForWave("wave1")).toEqual([
      "script",
      "reference",
      "pause-points",
    ]);
    expect(authoringLanesForWave("wave2")).toEqual([
      "workflow-entry",
      "skill-core",
    ]);
    expect(authoringLanesForWave("barrier")).toEqual(["skill-review"]);
    expect(authoringLaneWave("skill-core")).toBe("wave2");
    expect(authoringLaneDependencies("skill-review")).toEqual([
      "script",
      "reference",
      "pause-points",
      "workflow-entry",
      "skill-core",
    ]);
    expect(authoringDependencyClosure("skill-review")).toEqual(
      authoringLaneIds(),
    );
    expect(authoringDependencyClosure("workflow-entry")).toEqual([
      "script",
      "workflow-entry",
    ]);
    expect(authoringAffectedLanes("reference")).toEqual([
      "reference",
      "skill-review",
    ]);
    expect(authoringDependentLanes("script")).toEqual([
      "workflow-entry",
      "skill-core",
      "skill-review",
    ]);
  });

  it("derives active node claims and content ownership from one projection", () => {
    const options = {
      activeNodeIds: ["prepare", "publish"],
      workflowName: "Prepared Workflow",
    };
    const skillCore = authoringLaneProjection("skill-core", options);

    expect(skillCore.derivedClaims).toEqual([
      "skill-core:node-skill:prepare",
      "skill-core:node-skill:publish",
    ]);
    expect(skillCore.contentLeaves).toEqual([
      "../prepared-workflow-prepare/SKILL.md",
      "../prepared-workflow-publish/SKILL.md",
    ]);
    expect(authoringLaneClaimIds("skill-core", options)).toEqual(
      skillCore.claims.concat(skillCore.derivedClaims),
    );
    expect(authoringLaneContentLeaves("pause-points", options)).toEqual([
      "reference/decision-points.md",
      "reference/recovery.md",
    ]);
    expect(authoringContentLeaves(options)).toEqual([
      "SKILL.md",
      "../prepared-workflow-prepare/SKILL.md",
      "../prepared-workflow-publish/SKILL.md",
      "reference/decision-points.md",
      "reference/recovery.md",
      "reference/skill-review.md",
    ]);
    expect(authoringContentLeafOwners(options)).toEqual({
      "reference/decision-points.md": "pause-points",
      "reference/recovery.md": "pause-points",
      "SKILL.md": "workflow-entry",
      "prepared-workflow-prepare/SKILL.md": "skill-core",
      "prepared-workflow-publish/SKILL.md": "skill-core",
      "reference/skill-review.md": "skill-review",
    });
    expect(authoringProtocolProjection(options).lanes["skill-core"]).toEqual(
      skillCore,
    );
  });

  it("returns fresh projections and detects every contract hash dimension", () => {
    const dependencies = authoringLaneDependencies("skill-review");
    const projection = authoringProtocolProjection();
    const owners = authoringProtocolProjection({
      activeNodeIds: ["prepare"],
      workflowName: "Prepared Workflow",
    });

    expect(projection.hash).toBe(hashAuthoringProtocol(projection));
    (dependencies as string[]).push("script");
    (projection.lanes.script.claims as string[]).push("unexpected-claim");

    expect(authoringLaneDependencies("skill-review")).toEqual([
      "script",
      "reference",
      "pause-points",
      "workflow-entry",
      "skill-core",
    ]);
    expect(authoringLaneClaimIds("script")).not.toContain("unexpected-claim");
    expect(owners.lanes["skill-core"].contentLeaves).toEqual([
      "../prepared-workflow-prepare/SKILL.md",
    ]);
    expect(hashAuthoringProtocol()).toBe(AUTHORING_PROTOCOL_HASH);

    const changedProtocol = structuredClone(AUTHORING_PROTOCOL);
    changedProtocol.merge.contentLeaves.push("reference/new-leaf.md");
    expect(hashAuthoringProtocol(changedProtocol)).not.toBe(
      AUTHORING_PROTOCOL_HASH,
    );
    expect(hashAuthoringProtocol(projection)).not.toBe(AUTHORING_PROTOCOL_HASH);
  });

  it("validates the serialized contract used by compatibility consumers", () => {
    expect(validateAuthoringProtocol(AUTHORING_PROTOCOL)).toEqual([]);
    expect(validateAuthoringProtocol(authoringProtocolProjection())).toEqual(
      [],
    );
  });
});
