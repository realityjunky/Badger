import { describe, expect, it } from "vitest";
import { activityQuery, EMPTY_FILTERS } from "../src/api/organization.js";

describe("the activity query", () => {
  it("names only the filters that are set", () => {
    expect(activityQuery(EMPTY_FILTERS, null)).toBe("");

    expect(
      activityQuery(
        {
          actorEmail: " robin@example.com ",
          action: "group.created",
          channel: "web",
          targetType: "group",
          from: "",
          to: "",
        },
        null,
      ),
    ).toBe(
      "?actorEmail=robin%40example.com&action=group.created&channel=web&targetType=group",
    );
  });

  it("sends time bounds as ISO timestamps", () => {
    const query = activityQuery(
      {
        actorEmail: "",
        action: "",
        channel: "",
        targetType: "",
        from: "2026-10-27T00:00",
        to: "2026-10-28T12:30",
      },
      null,
    );

    const parameters = new URLSearchParams(query);
    for (const name of ["from", "to"]) {
      const value = parameters.get(name);
      expect(value).not.toBeNull();
      expect(value).toMatch(/Z$/u);
      expect(Number.isNaN(Date.parse(value ?? ""))).toBe(false);
    }
  });

  it("carries the cursor for the next, older page", () => {
    const query = activityQuery(EMPTY_FILTERS, "cursor-1");

    expect(query).toBe("?cursor=cursor-1");
  });

  it("drops blank text filters rather than asking for an empty match", () => {
    expect(
      activityQuery(
        {
          actorEmail: "  ",
          action: "",
          channel: "",
          targetType: "\t",
          from: "",
          to: "",
        },
        null,
      ),
    ).toBe("");
  });
});
