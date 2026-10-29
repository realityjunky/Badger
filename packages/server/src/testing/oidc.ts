import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";

export interface StubOidcProvider {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  setClaims(claims: Readonly<Record<string, unknown>>): void;
  setFailure(status: number | null): void;
  setEndpointFailure(path: string, status: number, body: string): void;
  setInvalidSignature(invalid: boolean): void;
  /**
   * Answer authorization with a page whose Approve link returns to Badger,
   * so the provider's page, not Badger's, starts the cross-site navigation
   * back, as a real sign-in or consent page does.
   */
  setConsentPage(enabled: boolean): void;
  stop(): Promise<void>;
}

/** A real HTTP provider with discovery, PKCE, one-use codes and signed JWTs. */
export async function startStubOidcProvider(): Promise<StubOidcProvider> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "stub-key",
    alg: "RS256",
    use: "sig",
  };
  const clientId = "badger-test";
  const clientSecret = "stub-client-secret";
  let issuer = "";
  let claims: Readonly<Record<string, unknown>> = {};
  let failure: number | null = null;
  let endpointFailure:
    { path: string; status: number; body: string } | undefined;
  let invalidSignature = false;
  let consentPage = false;
  const codes = new Map<
    string,
    { redirectUri: string; challenge: string; nonce: string }
  >();
  const server = createServer((request, response) => {
    const json = (status: number, body: unknown) =>
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname === endpointFailure?.path) {
      response
        .writeHead(endpointFailure.status, { "content-type": "text/plain" })
        .end(endpointFailure.body);
      return;
    }
    if (failure !== null) {
      json(failure, { error: "temporarily_unavailable" });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/openid-configuration"
    ) {
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/jwks") {
      json(200, { keys: [jwk] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      const params = url.searchParams;
      if (
        params.get("client_id") !== clientId ||
        params.get("response_type") !== "code" ||
        params.get("code_challenge_method") !== "S256" ||
        !params.get("nonce") ||
        !params.get("state")
      ) {
        json(400, { error: "invalid_request" });
        return;
      }
      const callback = new URL(params.get("redirect_uri")!);
      const code = randomUUID();
      codes.set(code, {
        redirectUri: callback.href,
        challenge: params.get("code_challenge")!,
        nonce: params.get("nonce")!,
      });
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", params.get("state")!);
      callback.searchParams.set("iss", issuer);
      if (consentPage) {
        const href = callback.href
          .replaceAll("&", "&amp;")
          .replaceAll('"', "&quot;");
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(
            `<!doctype html><title>Stub provider</title><a href="${href}">Approve</a>`,
          );
        return;
      }
      response.writeHead(302, { location: callback.href }).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const params = new URLSearchParams(body);
        const code = params.get("code") ?? "";
        const grant = codes.get(code);
        codes.delete(code);
        const basic = Buffer.from(
          (request.headers.authorization ?? "").replace(/^Basic /u, ""),
          "base64",
        )
          .toString()
          .split(":")
          .map((part) => new URLSearchParams(`value=${part}`).get("value"));
        const challenge = createHash("sha256")
          .update(params.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          basic.length !== 2 ||
          basic[0] !== clientId ||
          basic[1] !== clientSecret ||
          params.get("grant_type") !== "authorization_code" ||
          grant === undefined ||
          grant.redirectUri !== params.get("redirect_uri") ||
          challenge !== grant.challenge
        ) {
          json(400, { error: "invalid_grant" });
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const payload = {
          iss: issuer,
          aud: clientId,
          sub: "alice-id",
          email: "alice@example.com",
          email_verified: true,
          name: "Alice Ng",
          iat: now,
          exp: now + 300,
          nonce: grant.nonce,
          ...claims,
        };
        const encoded = [{ alg: "RS256", kid: "stub-key" }, payload]
          .map((part) =>
            Buffer.from(JSON.stringify(part)).toString("base64url"),
          )
          .join(".");
        const signature = sign("RSA-SHA256", Buffer.from(encoded), privateKey);
        if (invalidSignature) signature[0] ^= 1;
        json(200, {
          access_token: "stub-access-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: `${encoded}.${signature.toString("base64url")}`,
        });
      });
      return;
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("Stub provider did not bind");
  issuer = `http://127.0.0.1:${address.port}`;
  let stopped = false;
  return {
    issuer,
    clientId,
    clientSecret,
    setClaims: (next) => {
      claims = next;
    },
    setFailure: (next) => {
      failure = next;
    },
    setEndpointFailure: (path, status, body) => {
      endpointFailure = { path, status, body };
    },
    setInvalidSignature: (next) => {
      invalidSignature = next;
    },
    setConsentPage: (next) => {
      consentPage = next;
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
