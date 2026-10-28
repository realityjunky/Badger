export {
  startTestService,
  type RawRequestInput,
  type RawResponse,
  type TestService,
  type TestServiceMode,
  type TestServiceOptions,
} from "./harness.js";
export type { TestPerson } from "./identity.js";
export type {
  SourceCheck,
  SourceCheckWorker,
  WorkflowJob,
  WorkflowSkillPin,
} from "../workflow-source.js";
export {
  startStubPlatform,
  type StubPlatform,
  type StubPlatformOptions,
  type StubPlatformUser,
} from "./platform.js";

// Migration checks run the migration runner on a test database directly.
export { openTestDatabase, type TestDatabase } from "./database.js";
export {
  applyMigrations,
  inspectMigrations,
  loadBundledMigrations,
  type Migration,
  type MigrationState,
} from "../database/migrations.js";
