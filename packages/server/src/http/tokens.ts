import { createToken, listTokens, revokeToken } from "../tokens.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";

const ROOT = "/api/v1/me/tokens";
const TOKEN_PATH = /^\/api\/v1\/me\/tokens\/([^/]+)$/u;

export function tokenMethods(path: string): string | null {
  if (path === ROOT) return "GET, HEAD, POST";
  return TOKEN_PATH.test(path) ? "DELETE" : null;
}

export async function handleTokens(input: AuthorizedRequest): Promise<void> {
  const { request, reply, path, method, database, dependencies, context } =
    input;
  if (context.credential.kind === "token")
    return reply.error(403, "denied", "Only a signed-in person manages tokens");
  if (!(tokenMethods(path)?.split(", ").includes(method) ?? false))
    return reply.error(405, "invalid", "Method not allowed", {
      allow: tokenMethods(path) ?? "GET, HEAD",
    });
  if (method === "GET" || method === "HEAD")
    return reply.json(200, {
      tokens: await listTokens(database, context.personId),
    });
  const body = await readJsonBody(request);
  if (!body.ok) return reply.error(400, "invalid", body.message);
  if (method === "POST")
    return reply.json(
      201,
      await createToken(database, dependencies, context, body.value),
    );
  const id = decodeURIComponent(TOKEN_PATH.exec(path)![1]);
  return reply.json(200, {
    token: await revokeToken(database, dependencies, context, id, body.value),
  });
}
