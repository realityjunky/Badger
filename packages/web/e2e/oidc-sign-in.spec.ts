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

test("returns to a dashboard deep link after OpenID Connect sign-in with Strict cookies, then signs out", async ({
  page,
}) => {
  const cookieHeaders = new Map<string, string>();
  page.on("request", async (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/team/auth/oidc/"))
      cookieHeaders.set(pathname, (await request.allHeaders())["cookie"] ?? "");
  });
  const destination = `${origin}/team/settings/tokens?from=inbox&item=token%2F123`;
  await page.goto(destination);
  await page
    .getByRole("link", { name: "Sign in with your organization" })
    .click();
  await page.getByRole("link", { name: "Approve" }).click();
  await expect(page).toHaveURL(destination);
  await expect(page.getByTestId("page-settings")).toBeVisible();
  // The browser withholds the Strict flow cookie from the provider's
  // cross-site redirect; the callback page's same-origin continuation
  // carries it to the completion, which issues the session.
  expect(cookieHeaders.get("/team/auth/oidc/callback")).not.toContain(
    "badger_session_oidc_flow_",
  );
  expect(cookieHeaders.get("/team/auth/oidc/complete")).toMatch(
    /badger_session_oidc_flow_[a-f0-9]{64}=/u,
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

for (const order of [
  [0, 1],
  [1, 0],
]) {
  test(`two tabs complete sign-in with ${order[0] === 0 ? "the older" : "the newer"} tab first`, async ({
    context,
  }) => {
    const tabs = [await context.newPage(), await context.newPage()];
    const destinations = [
      `${origin}/team/settings/tokens?tab=first`,
      `${origin}/team/settings/tokens?tab=second`,
    ];
    for (const [index, tab] of tabs.entries()) {
      await tab.goto(destinations[index]);
      await tab
        .getByRole("link", { name: "Sign in with your organization" })
        .click();
      await expect(tab.getByRole("link", { name: "Approve" })).toBeVisible();
    }
    const pending = (await context.cookies(`${origin}/team/`)).filter(
      (cookie) => cookie.name.startsWith("badger_session_oidc_flow_"),
    );
    expect(pending).toHaveLength(2);
    for (const cookie of pending)
      expect(cookie).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/team",
      });
    for (const index of order) {
      await tabs[index].getByRole("link", { name: "Approve" }).click();
      await expect(tabs[index]).toHaveURL(destinations[index]);
      await expect(tabs[index].getByTestId("page-settings")).toBeVisible();
    }
    expect(
      (await context.cookies(`${origin}/team/`)).map((cookie) => cookie.name),
    ).toEqual(["badger_session"]);
  });
}
