import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ServiceConfig } from "../config.js";
import type { Database } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { readCookie, strictCookie } from "../identity/cookies.js";
import { OIDC_TRANSACTION_SECONDS } from "../identity/oidc.js";
import { firstHeader, type IdentityAdapter } from "../identity/identity.js";
import type { Logger } from "../log.js";
import { issueSession, revokeSession } from "../sessions.js";
import { escapeHtml, renderSignInFailedPage } from "./page.js";
import type { Reply } from "./responses.js";

const MAX_PENDING_BROWSER_SIGN_INS = 3;

/** OIDC returns cross-site. An HTML navigation starts a same-site request,
 * letting even the short-lived transaction cookie remain SameSite=Strict. */
function continueSignIn(reply: Reply, destination: string): void {
  const script = `window.location.replace(${JSON.stringify(destination).replaceAll("<", "\\u003c")});`;
  const hash = createHash("sha256").update(script).digest("base64");
  reply.send({
    status: 200,
    contentType: "text/html; charset=utf-8",
    headers: {
      "content-security-policy": `default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in to Badger</title></head><body><p><a href="${escapeHtml(destination)}">Continue signing in to Badger</a></p><script>${script}</script></body></html>`,
  });
}

export async function handleBrowserSignIn(input: {
  config: ServiceConfig;
  identity: IdentityAdapter;
  request: IncomingMessage;
  reply: Reply;
  url: URL;
  path: string;
  database: Database;
  dependencies: ServiceDependencies;
  logger?: Logger;
}): Promise<boolean> {
  const {
    config,
    identity,
    request,
    reply,
    url,
    path,
    database,
    dependencies,
    logger,
  } = input;
  if (config.identity.kind !== "oidc" || identity.browser === undefined)
    return false;
  const prefix = config.basePath === "/" ? "" : config.basePath;
  const routes = [
    "/auth/oidc/login",
    "/auth/oidc/callback",
    "/auth/oidc/complete",
    "/auth/logout",
  ];
  if (!routes.includes(path)) return false;
  if (firstHeader(request.headers, "authorization") !== null) {
    reply.error(
      403,
      "denied",
      "Sign-in requires a browser, not a personal access token",
    );
    return true;
  }
  const expectedMethod = path === "/auth/logout" ? "POST" : "GET";
  if (request.method !== expectedMethod) {
    reply.error(405, "invalid", "Method not allowed", {
      allow: expectedMethod,
    });
    return true;
  }
  const settings = config.identity.oidc;
  const flowCookiePrefix = `${settings.sessionCookie}_oidc_flow_`;
  const flowCookieName = (state: string) =>
    `${flowCookiePrefix}${createHash("sha256").update(state).digest("hex")}`;
  const pendingFlowCookies = [
    ...new Set(
      (firstHeader(request.headers, "cookie") ?? "")
        .split(";")
        .map((part) => part.trim().split("=")[0])
        .filter(
          (name) =>
            name.startsWith(flowCookiePrefix) &&
            /^[a-f0-9]{64}$/u.test(name.slice(flowCookiePrefix.length)),
        ),
    ),
  ];
  const cookie = (name: string, value: string, seconds: number) =>
    strictCookie(name, value, config.basePath, seconds);
  const redirect = (location: string, cookies: string[]) =>
    reply.send({
      status: 303,
      contentType: "text/plain; charset=utf-8",
      body: "",
      headers: { location, "set-cookie": cookies },
    });
  // A person reads these in the browser; the reason goes to the log only.
  const failed = (
    stage: string,
    result: { kind: "invalid" | "unavailable"; reason: string },
    cookies: string[] = [],
  ) => {
    const entry = {
      event: "oidc.sign-in-failed",
      stage,
      outcome: result.kind,
      reason: result.reason,
      requestId: reply.requestId,
    };
    if (result.kind === "unavailable") logger?.error(entry);
    else logger?.info(entry);
    reply.send({
      status: result.kind === "unavailable" ? 503 : 400,
      contentType: "text/html; charset=utf-8",
      headers: { "set-cookie": cookies },
      body: renderSignInFailedPage(
        result.kind === "unavailable"
          ? "The identity provider is unavailable. Try again later."
          : "Sign-in is invalid or expired.",
        `${prefix}/auth/oidc/login`,
      ),
    });
  };
  if (path === "/auth/oidc/login") {
    const result = await identity.browser.begin(
      url.searchParams.get("returnTo"),
    );
    if ("kind" in result) failed("login", result);
    else
      redirect(result.authorizationUrl, [
        // Cookies with the same path arrive oldest first (RFC 6265, 5.4).
        // Leave room for this flow, without clearing another tab on completion.
        ...pendingFlowCookies
          .slice(
            0,
            Math.max(
              0,
              pendingFlowCookies.length - MAX_PENDING_BROWSER_SIGN_INS + 1,
            ),
          )
          .map((name) => cookie(name, "", 0)),
        cookie(
          flowCookieName(result.state),
          result.transactionToken,
          OIDC_TRANSACTION_SECONDS,
        ),
      ]);
  } else if (path === "/auth/oidc/callback") {
    continueSignIn(reply, `${prefix}/auth/oidc/complete${url.search}`);
  } else if (path === "/auth/oidc/complete") {
    const callback = new URL(`${settings.publicUrl}/auth/oidc/callback`);
    callback.search = url.search;
    const states = callback.searchParams.getAll("state");
    if (states.length !== 1 || states[0] === "") {
      failed("callback", {
        kind: "invalid",
        reason: "no unique sign-in state",
      });
      return true;
    }
    const name = flowCookieName(states[0]);
    const result = await identity.browser.complete(
      readCookie(request.headers, name),
      callback,
    );
    // Every outcome ends this flow; clearing its cookie at once keeps a
    // failed tab from holding one of the browser's pending sign-in slots.
    if (result.kind !== "authenticated")
      failed("callback", result, [cookie(name, "", 0)]);
    else {
      const sessionToken = await issueSession(
        database,
        dependencies,
        settings,
        result.principal,
        reply.requestId,
      );
      redirect(result.returnPath, [
        cookie(settings.sessionCookie, sessionToken, settings.sessionSeconds),
        cookie(name, "", 0),
      ]);
    }
  } else {
    await revokeSession(
      database,
      dependencies,
      settings.issuer,
      readCookie(request.headers, settings.sessionCookie),
      reply.requestId,
    );
    redirect(`${prefix}/`, [
      cookie(settings.sessionCookie, "", 0),
      ...pendingFlowCookies.map((name) => cookie(name, "", 0)),
    ]);
  }
  return true;
}
