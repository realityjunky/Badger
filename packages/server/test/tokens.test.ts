import { afterEach, describe, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

const alice: TestPerson = { subject: "alice", email: "alice@example.com" };
const robin: TestPerson = { subject: "robin", email: "robin@example.com" };
let service: TestService;

afterEach(async () => {
  await service?.close();
});

function write(method: string, path: string, as: TestPerson, body: unknown) {
  return service.request(`/api/v1${path}`, {
    as,
    method,
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

async function setup() {
  service = await startTestService({
    environment: {
      BADGER_ALLOWED_ORIGINS: "http://localhost",
      BADGER_BOOTSTRAP_ADMINISTRATORS: "robin@example.com",
    },
  });
}

interface Token {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  revision: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedChannel: string | null;
}

async function createToken(as = alice, scopes = ["engineer"]) {
  const response = await write("POST", "/me/tokens", as, {
    name: "My Agent",
    scopes,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { token: Token; secret: string };
}

function bearer(secret: string, method = "GET", body?: unknown) {
  return {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-badger-agent-host": "test-agent",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function workflowForAlice(role = "Engineer") {
  const grouped = await write("POST", "/groups", robin, { name: "Research" });
  const { group } = (await grouped.json()) as { group: { id: string } };
  const created = await write("POST", "/workflows", robin, {
    groupId: group.id,
    name: "primer-designer",
    goal: "Design primers from reviewed sources.",
    intent: "new-skill",
    locale: "en",
  });
  const { workflow } = (await created.json()) as {
    workflow: { id: string; revision: number };
  };
  const assigned = await write("POST", "/bindings", robin, {
    scopeType: "workflow",
    scopeId: workflow.id,
    email: alice.email,
    role,
  });
  expect(assigned.status).toBe(201);
  const { binding } = (await assigned.json()) as {
    binding: { id: string; revision: number };
  };
  await service.request("/api/v1/me", { as: alice });
  return { workflow, group, binding };
}

describe("personal access tokens", () => {
  it("narrows Skill contributions to the profile matching the owner's workflow role", async () => {
    await setup();
    const { group } = await workflowForAlice("Field expert");
    const engineer = await createToken(alice, ["engineer"]);
    const expert = await createToken(alice, ["expert"]);
    const operator = await createToken(alice, ["operator"]);
    for (const [token, expected] of [
      [engineer, false],
      [expert, true],
      [operator, false],
    ] as const) {
      const response = await service.request(
        "/api/v1/skills",
        bearer(token.secret),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        groups: [
          { id: group.id, canUpload: expected, canCreateSkill: expected },
        ],
      });
    }
    const entry = { groupId: group.id, name: "example" };
    expect(
      (
        await service.request(
          "/api/v1/skills",
          bearer(engineer.secret, "POST", entry),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await service.request(
          "/api/v1/skills",
          bearer(operator.secret, "POST", entry),
        )
      ).status,
    ).toBe(403);
    const created = await service.request(
      "/api/v1/skills",
      bearer(expert.secret, "POST", entry),
    );
    expect(created.status).toBe(201);
    const { skill } = (await created.json()) as { skill: { id: string } };
    const content = {
      files: [
        {
          path: "SKILL.md",
          content: Buffer.from(
            "---\nname: example\ndescription: Example Skill\n---\n\n# Example\n",
          ).toString("base64"),
        },
      ],
      scripts: {},
    };
    const preview = await service.request(
      `/api/v1/skills/${skill.id}/upload-preview`,
      bearer(expert.secret, "POST", content),
    );
    expect(preview.status).toBe(200);
    const { preview: inspected } = (await preview.json()) as {
      preview: { hash: string };
    };
    const uploaded = await service.request(
      `/api/v1/skills/${skill.id}/versions`,
      bearer(expert.secret, "POST", {
        ...content,
        confirmed: true,
        expectedHash: inspected.hash,
      }),
    );
    expect(uploaded.status).toBe(201);
    expect(
      (
        await service.request(
          `/api/v1/skills/${skill.id}/upload-preview`,
          bearer(engineer.secret, "POST", content),
        )
      ).status,
    ).toBe(403);
    const activity = await service.request(
      "/api/v1/audit-events?action=skill_version.uploaded",
      { as: robin },
    );
    expect(await activity.json()).toMatchObject({
      events: [
        {
          credentialKind: "token",
          credentialId: expert.token.id,
          channel: "mcp",
        },
      ],
    });
  });

  it("authenticates beside the people-facing adapter when that provider is unavailable", async () => {
    let unavailable = false;
    service = await startTestService({
      environment: { BADGER_ALLOWED_ORIGINS: "http://localhost" },
      identity: {
        resolve: async () =>
          unavailable
            ? { kind: "unavailable", reason: "Provider unavailable" }
            : {
                kind: "authenticated",
                principal: {
                  issuer: "provider",
                  subject: "alice",
                  email: "alice@example.com",
                  displayName: "Alice",
                  emailVerified: true,
                  status: "active",
                  platformAdministrator: false,
                  credential: { kind: "session", id: "session" },
                },
              },
      },
    });
    const minted = await service.request("/api/v1/me/tokens", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "CLI", scopes: ["operator"] }),
    });
    expect(minted.status).toBe(201);
    const { secret } = (await minted.json()) as { secret: string };
    unavailable = true;
    expect((await service.request("/api/v1/me")).status).toBe(503);
    expect((await service.request("/api/v1/me", bearer(secret))).status).toBe(
      200,
    );
  });

  it("refuses people-only actions and token management even for an Administrator's token", async () => {
    await setup();
    const { secret, token } = await createToken(robin, [
      "engineer",
      "expert",
      "operator",
    ]);
    const actions = [
      "/facts/fact-1/confirm",
      "/facts/fact-1/acknowledge",
      "/facts/fact-1/dispute",
      "/workflows/workflow-1/versions/version-1/dossier/approve",
      "/workflows/workflow-1/versions/version-1/plan/approve",
      "/workflows/workflow-1/versions/version-1/proposal/approve",
      "/workflows/workflow-1/versions/version-1/package/approve",
      "/workflows/workflow-1/versions/version-1/publish",
      "/runs/run-1/gates/gate-1/answer",
      "/groups",
      "/bindings",
      "/me/tokens",
    ];
    for (const path of actions) {
      const response = await service.request(
        `/api/v1${path}`,
        bearer(secret, "POST", {}),
      );
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "denied" },
      });
    }
    expect(
      (await service.request("/api/v1/me/tokens", bearer(secret))).status,
    ).toBe(403);
    expect(
      (
        await service.request(
          `/api/v1/me/tokens/${token.id}`,
          bearer(secret, "DELETE", { revision: 1 }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await service.request(
          "/api/v1/me/preferences",
          bearer(secret, "PUT", {}),
        )
      ).status,
    ).toBe(403);
  });

  it("refuses revoked, expired, unknown, and malformed tokens without falling back to a session", async () => {
    await setup();
    const revoked = await createToken();
    await write("DELETE", `/me/tokens/${revoked.token.id}`, alice, {
      revision: 1,
    });
    const expires = await write("POST", "/me/tokens", alice, {
      name: "Short-lived CLI",
      scopes: ["operator"],
      expiresAt: "2026-10-27T00:00:01.000Z",
    });
    expect(expires.status).toBe(201);
    const expiring = (await expires.json()) as { secret: string };
    expect(
      (await service.request("/api/v1/me", bearer(expiring.secret))).status,
    ).toBe(200);
    service.clock.advance(1000);
    for (const authorization of [
      `Bearer ${revoked.secret}`,
      `Bearer ${expiring.secret}`,
      `Bearer bdg_${"a".repeat(16)}_${"a".repeat(43)}`,
      "Bearer broken",
      "Basic broken",
      "",
    ]) {
      const response = await service.request("/api/v1/me", {
        as: robin,
        headers: { authorization },
      });
      expect(response.status).toBe(401);
    }
    expect((await service.request("/api/v1/me", { as: robin })).status).toBe(
      200,
    );
  });

  it("keeps token writes independent of cookie origins and rejects foreign origins and missing session origins", async () => {
    await setup();
    const { workflow } = await workflowForAlice();
    const { secret } = await createToken();
    const path = `/api/v1/workflows/${workflow.id}/versions`;
    const session = await service.request(path, {
      as: alice,
      method: "POST",
      body: JSON.stringify({ revision: 1 }),
    });
    expect(session.status).toBe(403);
    const foreign = await service.request(path, {
      ...bearer(secret, "POST", { revision: 1 }),
      headers: {
        authorization: `Bearer ${secret}`,
        origin: "https://foreign.example",
      },
    });
    expect(foreign.status).toBe(403);
    expect(
      (await service.request(path, bearer(secret, "POST", { revision: 1 })))
        .status,
    ).toBe(201);
  });

  it("validates scopes and expiry and refuses revocation based on a stale revision", async () => {
    await setup();
    for (const scopes of [
      [],
      ["approve"],
      ["engineer", "engineer"],
      [null],
      "engineer",
    ]) {
      expect(
        (await write("POST", "/me/tokens", alice, { name: "Agent", scopes }))
          .status,
      ).toBe(400);
    }
    for (const expiresAt of [null, false, "invalid", "2026-10-27T00:00:00Z"]) {
      expect(
        (
          await write("POST", "/me/tokens", alice, {
            name: "Agent",
            scopes: ["expert"],
            expiresAt,
          })
        ).status,
      ).toBe(400);
    }
    const { token } = await createToken();
    expect(
      (await write("DELETE", `/me/tokens/${token.id}`, alice, { revision: 2 }))
        .status,
    ).toBe(409);
    const revoked = await write("DELETE", `/me/tokens/${token.id}`, alice, {
      revision: 1,
    });
    expect(revoked.status).toBe(200);
    const again = await write("DELETE", `/me/tokens/${token.id}`, alice, {
      revision: 2,
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ token: { revision: 2 } });
  });

  it("rate-limits concurrent requests per token, records every use, and resets after a minute", async () => {
    await setup();
    const first = await createToken();
    const second = await createToken();
    const responses = await Promise.all(
      Array.from({ length: 62 }, () =>
        service.request("/api/v1/me", bearer(first.secret)),
      ),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(60);
    const limited = responses.filter((response) => response.status === 429);
    expect(limited).toHaveLength(2);
    expect(limited[0].headers.get("retry-after")).toBe("60");
    expect(
      (await service.request("/api/v1/me", bearer(second.secret))).status,
    ).toBe(200);
    expect((await service.request("/api/v1/me", { as: alice })).status).toBe(
      200,
    );
    const activity = await service.request(
      "/api/v1/audit-events?action=token.used&limit=100",
      { as: robin },
    );
    const audit = (await activity.json()) as {
      events: { credentialId: string }[];
    };
    expect(
      audit.events.filter((event) => event.credentialId === first.token.id),
    ).toHaveLength(62);
    service.clock.advance(60_000);
    expect(
      (await service.request("/api/v1/me", bearer(first.secret))).status,
    ).toBe(200);
  });

  it("limits API actions to both the selected scope and the owner's current roles", async () => {
    await setup();
    const { workflow, binding } = await workflowForAlice();
    const engineer = await createToken(alice, ["engineer"]);
    const expert = await createToken(alice, ["expert"]);
    const operator = await createToken(alice, ["operator"]);
    for (const { secret } of [engineer, expert, operator]) {
      const read = await service.request(
        `/api/v1/workflows/${workflow.id}`,
        bearer(secret),
      );
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        capabilities: {
          read: true,
          editWorkflow: false,
          manageRoles: false,
          createVersion: secret === engineer.secret,
        },
      });
    }
    for (const { secret } of [expert, operator]) {
      const denied = await service.request(
        `/api/v1/workflows/${workflow.id}/versions`,
        bearer(secret, "POST", { revision: 1 }),
      );
      expect(denied.status).toBe(403);
    }
    const created = await service.request(
      `/api/v1/workflows/${workflow.id}/versions`,
      bearer(engineer.secret, "POST", { revision: 1 }),
    );
    expect(created.status).toBe(201);
    const removed = await write("DELETE", `/bindings/${binding.id}`, robin, {
      revision: 2,
    });
    expect(removed.status).toBe(200);
    const denied = await service.request(
      `/api/v1/workflows/${workflow.id}/versions`,
      bearer(engineer.secret, "POST", { revision: 2 }),
    );
    expect(denied.status).toBe(403);
  });

  it("authenticates as its owner and records the token, time, and channel of each use", async () => {
    await setup();
    const { token, secret } = await createToken();
    service.clock.advance(1000);

    const response = await service.request("/api/v1/me", {
      headers: {
        authorization: `Bearer ${secret}`,
        "x-badger-agent-host": "test-agent",
        "x-request-id": "agent-use",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      person: { subject: "alice", email: alice.email, roles: [] },
      credential: { kind: "token", id: token.id, scopes: ["engineer"] },
    });
    const listed = await service.request("/api/v1/me/tokens", { as: alice });
    expect(await listed.json()).toMatchObject({
      tokens: [
        {
          id: token.id,
          lastUsedAt: "2026-10-27T00:00:01.000Z",
          lastUsedChannel: "mcp",
        },
      ],
    });
    const activity = await service.request(
      "/api/v1/audit-events?action=token.used",
      { as: robin },
    );
    expect(await activity.json()).toMatchObject({
      events: [
        {
          action: "token.used",
          credentialKind: "token",
          credentialId: token.id,
          actorEmail: alice.email,
          agentHost: "test-agent",
          channel: "mcp",
          occurredAt: "2026-10-27T00:00:01.000Z",
          requestId: "agent-use",
        },
      ],
    });
  });

  it("shows a new secret once, lists only its owner's metadata, and revokes it", async () => {
    await setup();
    const created = await createToken();

    expect(created.secret).toMatch(/^bdg_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/u);
    expect(created.secret.startsWith(`${created.token.prefix}_`)).toBe(true);
    expect(created.token).toMatchObject({
      name: "My Agent",
      scopes: ["engineer"],
      revision: 1,
      createdAt: "2026-10-27T00:00:00.000Z",
      expiresAt: "2027-01-25T00:00:00.000Z",
      revokedAt: null,
      lastUsedAt: null,
      lastUsedChannel: null,
    });
    expect(JSON.stringify(created.token)).not.toContain(created.secret);
    const listed = await service.request("/api/v1/me/tokens", { as: alice });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ tokens: [created.token] });

    const other = await service.request("/api/v1/me/tokens", { as: robin });
    expect(await other.json()).toEqual({ tokens: [] });
    const foreign = await write(
      "DELETE",
      `/me/tokens/${created.token.id}`,
      robin,
      {
        revision: 1,
      },
    );
    expect(foreign.status).toBe(404);

    const revoked = await write(
      "DELETE",
      `/me/tokens/${created.token.id}`,
      alice,
      {
        revision: 1,
      },
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      token: {
        id: created.token.id,
        revokedAt: created.token.createdAt,
        revision: 2,
      },
    });
    const activity = await service.request("/api/v1/audit-events", {
      as: robin,
    });
    const audit = await activity.text();
    expect(audit).toContain("token.created");
    expect(audit).toContain("token.revoked");
    expect(audit).not.toContain(created.secret);
  });
});
