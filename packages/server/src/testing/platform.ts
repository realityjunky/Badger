import { createServer } from "node:http";

export interface StubPlatformUser {
  id: string;
  email: string;
  displayName?: string;
  status?: string;
  /** App names the platform has granted this person. */
  appGrants?: readonly string[];
  /** Whether the platform has verified this user's address; true by default. */
  emailVerified?: boolean;
  /** Whether the platform calls this user an administrator. */
  isAdmin?: boolean;
}

export interface StubPlatformOptions {
  /** Platform session token to the person the platform signs in. */
  users?: Readonly<Record<string, StubPlatformUser>>;
  cookieName?: string;
  currentUserPath?: string;
  /**
   * Where the current-user endpoint reads the token: the session cookie (the
   * default), or only an `Authorization: Bearer` header.
   */
  currentUserAuth?: "cookie" | "bearer";
}

/**
 * A stand-in for the platform's current-user endpoint: it signs in the token
 * it is given and says who that is, the way the real platform would.
 */
export interface StubPlatform {
  readonly url: string;
  readonly cookieName: string;
  readonly currentUserPath: string;
  readonly currentUserAuth: "cookie" | "bearer";
  /** How many requests reached the current-user endpoint. */
  readonly currentUserRequests: number;
  /** Answers every request with this status, or restores normal answers. */
  setFailure(status: number | null): void;
  stop(): Promise<void>;
}

const DEFAULT_COOKIE_NAME = "stub_platform_session";
const DEFAULT_CURRENT_USER_PATH = "/current-user";

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function readBearer(header: string | undefined): string | null {
  const match = /^Bearer (.+)$/u.exec(header ?? "");
  return match?.[1] ?? null;
}

function userBody(user: StubPlatformUser): unknown {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName ?? user.email,
    status: user.status ?? "active",
    email_verified: user.emailVerified ?? true,
    is_admin: user.isAdmin ?? false,
    app_access: (user.appGrants ?? []).map((appName) => ({
      app_name: appName,
      role: "user",
    })),
  };
}

export async function startStubPlatform(
  options: StubPlatformOptions = {},
): Promise<StubPlatform> {
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
  const currentUserPath = options.currentUserPath ?? DEFAULT_CURRENT_USER_PATH;
  const currentUserAuth = options.currentUserAuth ?? "cookie";
  const sessions = new Map(Object.entries(options.users ?? {}));
  let failure: number | null = null;
  let requests = 0;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub.invalid");
    if (request.method !== "GET" || url.pathname !== currentUserPath) {
      response.writeHead(404).end();
      return;
    }

    requests += 1;
    if (failure !== null) {
      response
        .writeHead(failure, { "content-type": "application/json" })
        .end(`${JSON.stringify({ error: "failed" })}\n`);
      return;
    }

    const token =
      currentUserAuth === "bearer"
        ? readBearer(request.headers.authorization)
        : readCookie(request.headers.cookie, cookieName);
    const user = token === null ? undefined : sessions.get(token);
    if (user === undefined) {
      response
        .writeHead(401, { "content-type": "application/json" })
        .end(`${JSON.stringify({ error: "unauthorized" })}\n`);
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(`${JSON.stringify(userBody(user))}\n`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;

  let stopped = false;
  return {
    url: `http://127.0.0.1:${port}`,
    cookieName,
    currentUserPath,
    currentUserAuth,
    get currentUserRequests() {
      return requests;
    },
    setFailure: (status) => {
      failure = status;
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
