import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Browser, type Page } from "@playwright/test";
import type {
  DossierEvidence,
  WorkingDossierContent,
  WorkingDossierEdit,
  WorkingDossierJob,
} from "@realityjunky/badger";
import {
  startStubOidcProvider,
  startTestService,
  type StubOidcProvider,
  type TestService,
} from "@realityjunky/badger-server/testing";
import type { VersionPreview } from "../../src/api/skills.js";

const port = process.env["BADGER_DOSSIER_E2E_PORT"] ?? "4325";
const origin = `http://localhost:${port}`;
export const base = `${origin}/team`;
const repository = fileURLToPath(new URL("../../../../", import.meta.url));

export const people = {
  admin: { sub: "admin", email: "admin@example.com", name: "Dalia Morgan" },
  engineer: {
    sub: "engineer",
    email: "engineer@example.com",
    name: "Alex Chen",
  },
  expert: { sub: "expert", email: "expert@example.com", name: "Mei Lin" },
  owner: { sub: "owner", email: "owner@example.com", name: "Noah Singh" },
};

export interface WorkflowVersion {
  workflowId: string;
  versionId: string;
}

export interface SourceFixture {
  name: string;
  files: ReadonlyMap<string, Buffer>;
}

export interface UploadedSource extends SourceFixture, VersionPreview {
  skillId: string;
}

export async function startDossierService() {
  const provider = await startStubOidcProvider();
  provider.setConsentPage(true);
  try {
    const service = await startTestService({
      mode: "service",
      environment: {
        BADGER_PORT: port,
        BADGER_BASE_PATH: "/team",
        BADGER_WEB_DIR: path.join(repository, "packages/web/dist"),
        BADGER_IDENTITY: "oidc",
        BADGER_PUBLIC_URL: base,
        BADGER_ALLOWED_ORIGINS: origin,
        BADGER_BOOTSTRAP_ADMINISTRATORS: people.admin.email,
        BADGER_OIDC_ISSUER: provider.issuer,
        BADGER_OIDC_CLIENT_ID: provider.clientId,
        BADGER_OIDC_CLIENT_SECRET: provider.clientSecret,
      },
    });
    return { provider, service };
  } catch (error) {
    await provider.stop();
    throw error;
  }
}

export async function signIn(
  browser: Browser,
  provider: StubOidcProvider,
  person: (typeof people)[keyof typeof people],
) {
  provider.setClaims(person);
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.goto(`${base}/my-work`);
  await page
    .getByRole("link", { name: "Sign in with your organization" })
    .click();
  await page.getByRole("link", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("user-menu")).toContainText(person.name);
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
  return page;
}

export async function api<Result>(
  page: Page,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<Result> {
  const response = await page.request.fetch(`${base}/api/v1${endpoint}`, {
    method,
    headers: { origin, "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok())
    throw new Error(
      `${method} ${endpoint}: ${response.status()} ${await response.text()}`,
    );
  return (await response.json()) as Result;
}

export async function openTeam(browser: Browser, provider: StubOidcProvider) {
  const admin = await signIn(browser, provider, people.admin);
  const engineer = await signIn(browser, provider, people.engineer);
  const expert = await signIn(browser, provider, people.expert);
  const owner = await signIn(browser, provider, people.owner);
  await engineer.goto(`${base}/settings/tokens`);
  await engineer
    .getByRole("button", { name: "Create token", exact: true })
    .click();
  const dialog = engineer.getByRole("dialog");
  await dialog
    .getByLabel("Name", { exact: true })
    .fill("Working dossier acceptance");
  await dialog.getByRole("checkbox", { name: "Engineer", exact: true }).check();
  await dialog
    .getByRole("button", { name: "Create token", exact: true })
    .click();
  const secret = await dialog
    .getByRole("textbox", { name: "Token secret" })
    .inputValue();
  await dialog.getByRole("button", { name: "I have saved the token" }).click();
  const agent = new Client({
    name: "Working dossier acceptance",
    version: "1",
  });
  await agent.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repository, "packages/mcp/dist/src/cli.js")],
      env: {
        BADGER_URL: base,
        BADGER_TOKEN: secret,
        BADGER_MCP_PROFILE: "engineer",
        BADGER_AGENT_HOST: "Working dossier acceptance",
        BADGER_MCP_MAX_INLINE_BYTES: "16777216",
      },
    }),
  );
  return { admin, engineer, expert, owner, agent };
}

export type Team = Awaited<ReturnType<typeof openTeam>>;

export async function mcp<Result>(
  agent: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Result> {
  const result = await agent.callTool({ name, arguments: args });
  const text = result.content as { type: string; text?: string }[];
  expect(result.isError, text[0]?.text).not.toBe(true);
  return JSON.parse(text.find((item) => item.type === "text")!.text!) as Result;
}

export async function createWorkflow(team: Team, name: string, goal: string) {
  const { group } = await api<{ group: { id: string } }>(
    team.admin,
    "POST",
    "/groups",
    { name },
  );
  const { workflow, version } = await api<{
    workflow: { id: string };
    version: { id: string };
  }>(team.admin, "POST", "/workflows", {
    groupId: group.id,
    name,
    goal,
    intent: "new-skill",
    locale: "en",
  });
  for (const [person, role] of [
    [people.engineer, "Engineer"],
    [people.expert, "Field expert"],
    [people.owner, "Workflow owner"],
  ] as const) {
    await api(team.admin, "POST", "/bindings", {
      scopeType: "workflow",
      scopeId: workflow.id,
      email: person.email,
      role,
    });
  }
  return { groupId: group.id, workflowId: workflow.id, versionId: version.id };
}

export function workflowPath({ workflowId, versionId }: WorkflowVersion) {
  return `/workflows/${workflowId}/versions/${versionId}`;
}

export async function uploadSource(
  page: Page,
  groupId: string,
  fixture: SourceFixture,
  existingSkillId?: string,
): Promise<UploadedSource> {
  const skillId =
    existingSkillId ??
    (
      await api<{ skill: { id: string } }>(page, "POST", "/skills", {
        groupId,
        name: fixture.name,
      })
    ).skill.id;
  const files = [...fixture.files].map(([file, bytes]) => ({
    path: file,
    content: bytes.toString("base64"),
  }));
  const { preview } = await api<{ preview: VersionPreview }>(
    page,
    "POST",
    `/skills/${skillId}/upload-preview`,
    { files },
  );
  await api(page, "POST", `/skills/${skillId}/versions`, {
    files,
    confirmed: true,
    expectedHash: preview.hash,
  });
  return { ...fixture, ...preview, skillId };
}

export async function pinSources(
  service: TestService,
  page: Page,
  workflow: WorkflowVersion,
  sources: UploadedSource[],
) {
  const root = workflowPath(workflow);
  for (const { skillId, hash } of sources)
    await api(page, "POST", `${root}/pins`, { skillId, hash });
  await confirmSources(service, page, workflow);
}

export async function confirmSources(
  service: TestService,
  page: Page,
  workflow: WorkflowVersion,
) {
  await service.runSourceCheckJobs();
  await page.goto(`${base}${workflowPath(workflow)}#sources`);
  await page
    .getByRole("button", { name: "Review Sources", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm source set" })
    .click();
  await expect(page.getByText(/^Sources confirmed /u)).toBeVisible();
}

export function cite(
  source: UploadedSource,
  file: string,
  first: string,
  last = first,
): DossierEvidence {
  const entry = source.inventory.find((item) => item.path === file);
  expect(entry, `${source.name}/${file} in the pinned inventory`).toBeDefined();
  const lines = source.files.get(file)!.toString("utf8").split(/\r?\n/u);
  const start = lines.findIndex((line) => line.includes(first));
  expect(
    start,
    `${source.name}/${file} includes ${first}`,
  ).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (line, index) => index >= start && line.includes(last),
  );
  expect(end, `${source.name}/${file} includes ${last}`).toBeGreaterThanOrEqual(
    start,
  );
  return {
    skillId: source.skillId,
    hash: source.hash,
    path: file,
    fileHash: entry!.hash,
    startLine: start + 1,
    endLine: end + 1,
  };
}

export async function openPinSet(
  service: TestService,
  team: Team,
  workflow: WorkflowVersion,
  sources: UploadedSource[],
) {
  await pinSources(service, team.engineer, workflow, sources);
  const study = `${base}${workflowPath(workflow)}#source-study`;
  await Promise.all([team.engineer.goto(study), team.expert.goto(study)]);
  await expect(
    team.expert
      .getByRole("region", { name: "Pinned Skills" })
      .getByRole("button", { name: sources[0]!.name, exact: true }),
  ).toBeVisible();
  await team.engineer
    .getByRole("button", { name: "Copy prompt", exact: true })
    .click();
  const prompt = await team.engineer.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(prompt).toContain(base);
  expect(prompt).toContain("working_dossier_sources");
  expect(prompt).toContain("save_working_dossier");
  const match = /working_dossier_job with (\{[^\n]+\})\./u.exec(prompt);
  expect(match, prompt).toBeTruthy();
  const ids = JSON.parse(match![1]!) as WorkflowVersion;
  expect(ids).toEqual({
    workflowId: workflow.workflowId,
    versionId: workflow.versionId,
  });
  await team.engineer
    .getByRole("dialog")
    .getByRole("button", { name: "Close" })
    .click();
  const job = await mcp<WorkingDossierJob>(team.agent, "working_dossier_job", {
    ...ids,
  });
  expect(job.workflow).toMatchObject({
    id: ids.workflowId,
    versionId: ids.versionId,
  });
  expect(
    job.pins.map(({ skillId, hash, name }) => ({ skillId, hash, name })),
  ).toEqual(
    expect.arrayContaining(
      sources.map(({ skillId, hash, name }) => ({ skillId, hash, name })),
    ),
  );
  expect(job.pins).toHaveLength(sources.length);
  expect(job.reviewUrl).toContain(base);
  await expect(
    team.expert.getByRole("button", {
      name: "Copy prompt",
      exact: true,
    }),
  ).toHaveCount(0);
  return { ids, job, prompt };
}

export type SavedDossier = {
  revision: number;
  savedRevision: number;
  reviewUrl: string;
};
export type MaterializedSources = {
  folder: string;
  files: {
    skillId: string;
    path: string;
    hash: string;
    localPath: string;
    source: "local" | "badger";
  }[];
};
export async function save(
  team: Team,
  ids: WorkflowVersion,
  edit: WorkingDossierEdit,
) {
  return mcp<SavedDossier>(team.agent, "save_working_dossier", {
    ...ids,
    edit,
  });
}

export function firstEdit(
  job: WorkingDossierJob,
  content: WorkingDossierContent,
): WorkingDossierEdit {
  return {
    ...content,
    editId: randomUUID(),
    revision: job.dossier.revision,
    pinsHash: job.dossier.pinsHash,
  };
}
