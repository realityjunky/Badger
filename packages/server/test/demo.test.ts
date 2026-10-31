import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startTestService, type TestService } from "../src/testing/index.js";

let service: TestService | undefined;
let webRoot: string | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
  if (webRoot) await fs.rm(webRoot, { recursive: true, force: true });
  webRoot = undefined;
});

describe("the read-only demo", () => {
  it("serves sample workflows without an identity provider or a working database", async () => {
    service = await startTestService({
      identity: {
        resolve: async () => {
          throw new Error("Demo requests must not identify a real person");
        },
      },
    });
    await service.closeDatabase();

    const response = await service.request("/demo/api/v1/workflows", {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workflows: [{ id: "demo-workflow", name: "Sample review" }],
      createGroups: [],
    });
    expect(
      service.logs.filter((entry) => entry.event === "identity.failed"),
    ).toEqual([]);
  });

  it("serves the seven main pages' records and refuses unknown real IDs", async () => {
    service = await startTestService();
    await service.closeDatabase();
    for (const [resource, expected] of [
      [
        "me/inbox",
        { items: [{ id: "demo-inbox-question" }, { id: "demo-inbox-gate" }] },
      ],
      ["workflows/demo-workflow", { workflow: { name: "Sample review" } }],
      ["questionnaire", { versions: [{ workflowId: "demo-workflow" }] }],
      ["skills", { skills: [{ id: "demo-skill" }] }],
      ["me/runs", { runs: [{ id: "demo-run" }] }],
      [
        "runs/demo-run",
        {
          run: {
            id: "demo-run",
            integrityFindings: [],
            needsRecovery: false,
            recovery: null,
          },
        },
      ],
      [
        "workflows/demo-workflow/versions/demo-version/evaluations",
        { reports: [{ id: "demo-evaluation" }] },
      ],
      ["audit-events", { events: [{ id: "demo-activity" }] }],
    ] as const) {
      const response = await service.request(`/demo/api/v1/${resource}`);
      expect(response.status, resource).toBe(200);
      expect(await response.json(), resource).toMatchObject(expected);
    }
    for (const resource of [
      "workflows/real-workflow",
      "skills/real-skill/versions",
      "runs/real-run",
      "me/tokens",
      "groups",
    ]) {
      expect(
        (await service.request(`/demo/api/v1/${resource}`)).status,
        resource,
      ).toBe(404);
    }
  });

  it("refuses every non-read method before authentication, including sign-offs, tokens, and logout", async () => {
    service = await startTestService({
      environment: { BADGER_ALLOWED_ORIGINS: "http://localhost" },
    });
    await service.closeDatabase();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const resource of [
        "/api/v1/workflows",
        "/api/v1/me/preferences",
        "/api/v1/me/tokens",
        "/api/v1/runs/demo-run/gates/demo-run-gate/answer",
        "/api/v1/workflows/demo-workflow/versions/demo-version/gates/publication/commit",
        "/auth/logout",
      ]) {
        const response = await service.request(`/demo${resource}`, {
          method,
          headers: {
            origin: "http://localhost",
            authorization: "Bearer invalid",
          },
          body: "{}",
        });
        expect(response.status, `${method} ${resource}`).toBe(405);
        expect(response.headers.get("allow")).toBe("GET, HEAD");
        expect(await response.json()).toMatchObject({
          error: { message: "Demo mode is read-only" },
        });
      }
    }
    const head = await service.request("/demo/api/v1/workflows", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("keeps a signed-in person's real records separate and does not write an audit event", async () => {
    service = await startTestService({ mode: "local" });
    const created = await service.request("/api/v1/groups", {
      method: "POST",
      headers: { origin: service.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Private live team" }),
    });
    expect(created.status).toBe(201);
    const auditBefore = await (
      await service.request("/api/v1/audit-events")
    ).json();
    const groupsBefore = await (await service.request("/api/v1/groups")).json();
    const demo = await service.request("/demo/api/v1/workflows");
    expect(await demo.text()).not.toContain("Private live team");
    const refused = await service.request("/demo/api/v1/groups", {
      method: "POST",
      headers: { origin: service.baseUrl },
      body: JSON.stringify({ name: "Attempted demo write" }),
    });
    expect(refused.status).toBe(405);
    expect(await (await service.request("/api/v1/groups")).json()).toEqual(
      groupsBefore,
    );
    expect(
      await (await service.request("/api/v1/audit-events")).json(),
    ).toEqual(auditBefore);
  });

  it("serves every demo page and its assets under the deployment prefix while live pages still require sign-in", async () => {
    webRoot = await fs.mkdtemp(path.join(os.tmpdir(), "badger-demo-web-"));
    await fs.copyFile(
      new URL("../../web/index.html", import.meta.url),
      path.join(webRoot, "index.html"),
    );
    await fs.mkdir(path.join(webRoot, "assets"));
    await fs.writeFile(
      path.join(webRoot, "assets", "app.js"),
      "// demo build\n",
    );
    service = await startTestService({
      environment: { BADGER_BASE_PATH: "/badger", BADGER_WEB_DIR: webRoot },
    });
    await service.closeDatabase();
    for (const page of [
      "",
      "/index.html",
      "/%69ndex.html",
      "/assets/..%2findex.html",
      "/my-work",
      "/workflows/demo-workflow/versions/demo-version",
      "/questionnaire/questions/demo-question",
      "/skills/demo-skill",
      "/runs/demo-run",
      "/evaluations",
      "/activity",
    ]) {
      const response = await service.request(`/badger/demo${page}`);
      expect(response.status, page).toBe(200);
      const html = await response.text();
      expect(html).toContain('name="badger-demo" content="true"');
      expect(html).toContain('name="badger-base-path" content="/badger/demo"');
      expect(html).toContain('<base href="/badger/demo/">');
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain(
        "script-src 'self'",
      );
    }
    const asset = await service.request("/badger/demo/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(
      (await service.request("/badger/demo/assets/missing.js")).status,
    ).toBe(404);
    expect((await service.request("/badger/demo/api/v1/me")).status).toBe(200);
    expect((await service.request("/badger/api/v1/me")).status).toBe(401);
    expect((await service.request("/badger/my-work")).status).toBe(401);
    expect((await service.request("/demo/api/v1/me")).status).toBe(404);
  });
});
