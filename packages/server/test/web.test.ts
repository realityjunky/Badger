import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

let service: TestService | undefined;
let webRoot: string | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
  if (webRoot !== undefined) {
    await fs.rm(webRoot, { recursive: true, force: true });
    webRoot = undefined;
  }
});

const WRITE_ORIGIN = "http://localhost";

const alice: TestPerson = {
  subject: "alice",
  email: "alice@example.com",
  displayName: "Alice Ng",
};

async function builtWebDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "badger-web-"));
  webRoot = directory;
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(
    path.join(directory, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="badger-base-path" content="/">
<base href="/">
<title>Badger</title>
<script type="module" src="./assets/app.js"></script>
</head>
<body><div id="root"></div></body>
</html>
`,
  );
  await fs.writeFile(
    path.join(directory, "assets", "app.js"),
    "console.log('badger');\n",
  );
  await fs.writeFile(
    path.join(directory, "assets", "app.css"),
    "body { margin: 0; }\n",
  );
  return directory;
}

describe("the dashboard the server serves", () => {
  it("serves the app shell at the root and on every page URL", async () => {
    service = await startTestService({
      environment: { BADGER_WEB_DIR: await builtWebDirectory() },
    });

    const root = await service.request("/", { as: alice });
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain('id="root"');

    const page = await service.request("/questionnaire/questions/q-1?round=2", {
      as: alice,
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('id="root"');
  });

  it("injects the deployment's base path into the document", async () => {
    service = await startTestService({
      environment: {
        BADGER_WEB_DIR: await builtWebDirectory(),
        BADGER_BASE_PATH: "/badger",
      },
    });

    const response = await service.request("/badger/workflows/w-1", {
      as: alice,
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<base href="/badger/">');
    expect(html).toContain('name="badger-base-path" content="/badger"');
  });

  it("serves the build's assets with their type and a long cache", async () => {
    service = await startTestService({
      environment: { BADGER_WEB_DIR: await builtWebDirectory() },
    });

    const script = await service.request("/assets/app.js", { as: alice });
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(script.headers.get("cache-control")).toContain("immutable");

    const style = await service.request("/assets/app.css", { as: alice });
    expect(style.headers.get("content-type")).toContain("text/css");
  });

  it("refuses to serve a file outside the build", async () => {
    service = await startTestService({
      environment: { BADGER_WEB_DIR: await builtWebDirectory() },
    });

    const response = await service.request(
      "/assets/..%2f..%2f..%2fetc%2fpasswd",
      { as: alice },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("root:");
  });

  it("answers a missing asset as not found instead of the app shell", async () => {
    service = await startTestService({
      environment: { BADGER_WEB_DIR: await builtWebDirectory() },
    });

    const response = await service.request("/assets/missing.js", {
      as: alice,
    });

    expect(response.status).toBe(404);
  });

  it("gives the app a policy that allows its own scripts and injected styles", async () => {
    service = await startTestService({
      environment: { BADGER_WEB_DIR: await builtWebDirectory() },
    });

    const page = await service.request("/my-work", { as: alice });
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("frame-ancestors 'none'");

    const api = await service.request("/api/v1/me", { as: alice });
    expect(api.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  });

  it("serves assets as files, not as writable resources", async () => {
    service = await startTestService({
      environment: {
        BADGER_WEB_DIR: await builtWebDirectory(),
        BADGER_ALLOWED_ORIGINS: WRITE_ORIGIN,
      },
    });

    const response = await service.request("/assets/app.js", {
      method: "POST",
      headers: { origin: WRITE_ORIGIN },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("serves assets without requiring a signed-in person", async () => {
    service = await startTestService({
      environment: { BADGER_WEB_DIR: await builtWebDirectory() },
    });

    expect((await service.request("/assets/app.js")).status).toBe(200);
  });

  it("shows the signed-out page on a dashboard URL opened while signed out", async () => {
    service = await startTestService({
      environment: { BADGER_WEB_DIR: await builtWebDirectory() },
    });

    const page = await service.request("/questionnaire/questions/q-1");
    expect(page.status).toBe(401);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Not signed in");

    const api = await service.request("/api/v1/me/preferences");
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
  });

  it("serves a page whose last segment has a dot as a page, not a file", async () => {
    service = await startTestService({
      environment: { BADGER_WEB_DIR: await builtWebDirectory() },
    });

    const page = await service.request("/workflows/w-1/versions/1.2", {
      as: alice,
    });

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="root"');
  });
});
