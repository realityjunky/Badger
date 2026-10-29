import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  startStubOidcProvider,
  startTestService,
  type StubOidcProvider,
  type TestService,
} from "@realityjunky/badger-server/testing";

// Badger answers on localhost and the provider on 127.0.0.1, so the
// provider's redirect back is a cross-site navigation, as in a deployment.
const origin = "http://localhost:4323";
let provider: StubOidcProvider;
let service: TestService;

test.beforeAll(async () => {
  provider = await startStubOidcProvider();
  provider.setConsentPage(true);
  service = await startTestService({
    mode: "service",
    environment: {
      BADGER_PORT: "4323",
      BADGER_BASE_PATH: "/team",
      BADGER_WEB_DIR: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../dist",
      ),
      BADGER_IDENTITY: "oidc",
      BADGER_PUBLIC_URL: `${origin}/team`,
      BADGER_ALLOWED_ORIGINS: origin,
      BADGER_OIDC_ISSUER: provider.issuer,
      BADGER_OIDC_CLIENT_ID: provider.clientId,
      BADGER_OIDC_CLIENT_SECRET: provider.clientSecret,
    },
  });
});
test.afterAll(async () => {
  await service?.close();
  await provider?.stop();
});

test("signs in through OpenID Connect with Strict cookies across the provider's redirect, then signs out", async ({
  page,
}) => {
  const cookieHeaders = new Map<string, string>();
  page.on("request", async (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/team/auth/oidc/"))
      cookieHeaders.set(pathname, (await request.allHeaders())["cookie"] ?? "");
  });
  await page.goto(`${origin}/team/my-work`);
  await page
    .getByRole("link", { name: "Sign in with your organization" })
    .click();
  await page.getByRole("link", { name: "Approve" }).click();
  await expect(page).toHaveURL(`${origin}/team/`);
  // The browser withholds the Strict flow cookie from the provider's
  // cross-site redirect; the callback page's same-origin continuation
  // carries it to the completion, which issues the session.
  expect(cookieHeaders.get("/team/auth/oidc/callback")).not.toContain(
    "badger_session_oidc_flow=",
  );
  expect(cookieHeaders.get("/team/auth/oidc/complete")).toContain(
    "badger_session_oidc_flow=",
  );
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
  await expect(page.getByTestId("user-menu")).toContainText("Alice Ng");
  // Badger's cookies are scoped to the base path.
  const cookies = await page.context().cookies(`${origin}/team/`);
  expect(cookies.map((cookie) => cookie.name)).toEqual(["badger_session"]);
  expect(cookies[0]).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/team",
  });

  await page.getByTestId("user-menu").click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("Not signed in.")).toBeVisible();
  expect(await page.context().cookies(`${origin}/team/`)).toEqual([]);
  const me = await page.request.get(`${origin}/team/api/v1/me`);
  expect(me.status()).toBe(401);
});
