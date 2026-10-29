import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ServiceConfig } from "../config.js";
import { readCookie, strictCookie } from "../identity/cookies.js";
import { OIDC_TRANSACTION_SECONDS } from "../identity/oidc.js";
import {
  firstHeader,
  type IdentityAdapter,
  type Principal,
} from "../identity/identity.js";
import { escapeHtml } from "./page.js";
import type { Reply } from "./responses.js";

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
  signIn(principal: Principal, requestId: string): Promise<unknown>;
}): Promise<boolean> {
  const { config, identity, request, reply, url, path, signIn } = input;
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
  const flowCookieName = `${settings.sessionCookie}_oidc_flow`;
  const cookie = (name: string, value: string, seconds: number) =>
    strictCookie(name, value, config.basePath, seconds);
  const redirect = (location: string, cookies: string[]) =>
    reply.send({
      status: 303,
      contentType: "text/plain; charset=utf-8",
      body: "",
      headers: { location, "set-cookie": cookies },
    });
  if (path === "/auth/oidc/login") {
    const result = await identity.browser.begin();
    if ("kind" in result)
      reply.error(503, "unavailable", "The identity provider is unavailable");
    else
      redirect(result.authorizationUrl, [
        cookie(
          flowCookieName,
          result.transactionToken,
          OIDC_TRANSACTION_SECONDS,
        ),
      ]);
  } else if (path === "/auth/oidc/callback") {
    continueSignIn(reply, `${prefix}/auth/oidc/complete${url.search}`);
  } else if (path === "/auth/oidc/complete") {
    const callback = new URL(`${settings.publicUrl}/auth/oidc/callback`);
    callback.search = url.search;
    const result = await identity.browser.complete(
      readCookie(request.headers, flowCookieName),
      callback,
    );
    if (result.kind === "unavailable")
      reply.error(503, "unavailable", "The identity provider is unavailable");
    else if (result.kind === "invalid")
      reply.error(400, "invalid", "Sign-in is invalid or expired; start again");
    else {
      await signIn(result.principal, reply.requestId);
      redirect(`${prefix}/`, [
        cookie(
          settings.sessionCookie,
          result.sessionToken,
          settings.sessionSeconds,
        ),
        cookie(flowCookieName, "", 0),
      ]);
    }
  } else {
    await identity.browser.signOut({
      method: "POST",
      headers: request.headers,
      hostname: null,
      remoteAddress: request.socket.remoteAddress ?? null,
    });
    redirect(`${prefix}/`, [
      cookie(settings.sessionCookie, "", 0),
      cookie(flowCookieName, "", 0),
    ]);
  }
  return true;
}
