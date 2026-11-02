import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

let service: TestService | undefined;
let deliveryServer: Server | undefined;

afterEach(async () => {
  await service?.close();
  await new Promise<void>((resolve, reject) => {
    if (!deliveryServer) return resolve();
    deliveryServer.close((error) => (error ? reject(error) : resolve()));
  });
  service = undefined;
  deliveryServer = undefined;
});

const inviter: TestPerson = { subject: "robin", email: "robin@example.com" };

async function write(path: string, body: unknown, as = inviter) {
  return service!.request(path, {
    method: "POST",
    as,
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

async function startDelivery() {
  const state = {
    status: 200,
    body: JSON.stringify({ emailSent: true }),
    requests: 0,
  };
  deliveryServer = createServer((request, response) => {
    state.requests += 1;
    request.resume();
    response.writeHead(state.status, {
      "content-type": "application/json",
      location: "/redirected",
    });
    response.end(state.body);
  });
  await new Promise<void>((resolve) =>
    deliveryServer!.listen(0, "127.0.0.1", resolve),
  );
  const address = deliveryServer.address();
  if (typeof address !== "object" || address === null)
    throw new Error("No delivery address");
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: inviter.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
      BADGER_PUBLIC_URL: "http://localhost",
      BADGER_INVITATION_DELIVERY_URL: `http://127.0.0.1:${address.port}/invitations`,
      BADGER_INVITATION_DELIVERY_TOKEN: "test-invitation-token",
    },
  });
  return state;
}

const invitationInput = {
  scopeType: "organization",
  email: "bob@example.com",
  role: "Auditor",
};

it.each([
  { status: 503, body: "unavailable" },
  { status: 200, body: JSON.stringify({ emailSent: false }) },
  { status: 200, body: "not JSON" },
  { status: 302, body: "redirect" },
])(
  "keeps the binding and reports failed delivery for $status / $body",
  async ({ status, body }) => {
    const delivery = await startDelivery();
    delivery.status = status;
    delivery.body = body;
    const response = await write("/api/v1/bindings", invitationInput);
    expect(response.status).toBe(201);
    const answer = await response.json();
    expect(answer).toMatchObject({
      binding: { pending: true },
      invitationDelivery: { status: "failed" },
    });
    expect(delivery.requests).toBe(1);
    const pending = await service!.request("/api/v1/invitations", {
      as: inviter,
    });
    expect(await pending.json()).toMatchObject({
      invitations: [{ id: answer.binding.id }],
    });
    delivery.status = 200;
    delivery.body = JSON.stringify({ emailSent: true });
    const resent = await write(
      `/api/v1/bindings/${answer.binding.id}/invitation-email`,
      { revision: 1 },
    );
    expect(resent.status).toBe(200);
    expect(await resent.json()).toMatchObject({
      invitationDelivery: { status: "sent" },
    });
    expect(delivery.requests).toBe(2);
    const audit = await service!.request(
      "/api/v1/audit-events?action=invitation.email_sent",
      { as: inviter },
    );
    expect(await audit.json()).toMatchObject({
      events: [{ targetId: answer.binding.id }],
    });
    expect(JSON.stringify(service!.logs)).not.toContain(
      "test-invitation-token",
    );
  },
);

it("refuses unauthorized and stale resends without sending email", async () => {
  const delivery = await startDelivery();
  const response = await write("/api/v1/bindings", invitationInput);
  const { binding } = await response.json();
  const path = `/api/v1/bindings/${binding.id}/invitation-email`;
  const denied = await write(
    path,
    { revision: 1 },
    { subject: "other", email: "other@example.com" },
  );
  expect(denied.status).toBe(403);
  expect((await write(path, { revision: 2 })).status).toBe(409);
  expect((await write(path, {})).status).toBe(400);
  expect((await write("/api/v1/bindings", invitationInput)).status).toBe(409);
  expect(delivery.requests).toBe(1);
});

it("sends no email for a refused or rolled-back role binding", async () => {
  const delivery = await startDelivery();
  expect(
    (
      await write("/api/v1/bindings", invitationInput, {
        subject: "other",
        email: "other@example.com",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await write("/api/v1/bindings", {
        ...invitationInput,
        email: inviter.email,
      })
    ).status,
  ).toBe(409);
  service!.failNextTransaction("40001");
  expect((await write("/api/v1/bindings", invitationInput)).status).toBe(503);
  expect(delivery.requests).toBe(0);
});

it("reports when email delivery is not configured", async () => {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: inviter.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const response = await write("/api/v1/bindings", invitationInput);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    invitationDelivery: { status: "not-configured" },
  });
});

it("delivers an invitation through the configured platform after recording the binding", async () => {
  const deliveries: { authorization: string | undefined; body: unknown }[] = [];
  deliveryServer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    deliveries.push({
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ emailSent: true }));
  });
  await new Promise<void>((resolve) =>
    deliveryServer!.listen(0, "127.0.0.1", resolve),
  );
  const address = deliveryServer.address();
  if (typeof address !== "object" || address === null)
    throw new Error("No delivery address");
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: "robin@example.com",
      BADGER_ALLOWED_ORIGINS: "http://localhost",
      BADGER_PUBLIC_URL: "http://localhost",
      BADGER_INVITATION_DELIVERY_URL: `http://127.0.0.1:${address.port}/invitations`,
      BADGER_INVITATION_DELIVERY_TOKEN: "test-invitation-token",
    },
  });
  const response = await service.request("/api/v1/bindings", {
    method: "POST",
    as: {
      subject: "robin",
      email: "robin@example.com",
      displayName: "Robin Alvarez",
    },
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({
      scopeType: "organization",
      email: "bob@example.com",
      role: "Auditor",
    }),
  });

  expect(response.status).toBe(201);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({
    authorization: "Bearer test-invitation-token",
    body: {
      email: "bob@example.com",
      role: "Auditor",
      url: "http://localhost/",
    },
  });
  expect(await response.json()).toMatchObject({
    binding: { pending: true, email: "bob@example.com" },
    invitationDelivery: { status: "sent" },
  });
});
