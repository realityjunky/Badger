import { afterEach, describe, expect, it } from "vitest";
import { startTestService, type TestService } from "../src/testing/index.js";

let service: TestService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

const built = {
  environment: { BADGER_REVISION: "abcdef0", BADGER_CLEAN_TREE: "true" },
};

describe("the health endpoint", () => {
  it("reports status, revision, clean-tree flag, database reachability, and migration state", async () => {
    service = await startTestService(built);

    const response = await service.request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      status: "ok",
      revision: "abcdef0",
      cleanTree: true,
      database: { reachable: true },
      migrations: {
        state: "applied",
        applied: ["0001", "0002", "0003"],
        pending: [],
        drifted: [],
      },
    });
  });

  it("needs no signed-in person", async () => {
    service = await startTestService();

    const response = await service.request("/health");

    expect(response.status).toBe(200);
  });

  it("reports an unknown revision when the build supplied none", async () => {
    service = await startTestService();

    const report = (await (await service.request("/health")).json()) as {
      revision: string;
      cleanTree: boolean | null;
    };

    expect(report.revision).toBe("unknown");
    expect(report.cleanTree).toBeNull();
  });

  it("reports degraded when the database is unreachable", async () => {
    service = await startTestService(built);
    await service.closeDatabase();

    const response = await service.request("/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "degraded",
      revision: "abcdef0",
      cleanTree: true,
      database: { reachable: false },
      migrations: {
        state: "unavailable",
        applied: [],
        pending: [],
        drifted: [],
      },
    });
  });
});
