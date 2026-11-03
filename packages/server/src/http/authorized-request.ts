import type { IncomingMessage } from "node:http";
import type { WriteContext } from "../audit.js";
import type { Access } from "../authorization.js";
import type { ServiceConfig } from "../config.js";
import type { Database } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import type { Person } from "../people.js";
import type { BlobStore } from "../skills/blobs.js";
import type { Reply } from "./responses.js";

export interface AuthorizedRequest {
  request: IncomingMessage;
  reply: Reply;
  url: URL;
  path: string;
  method: string;
  config: ServiceConfig;
  database: Database;
  dependencies: ServiceDependencies;
  context: WriteContext;
  access: Access;
  refreshAccess(): Promise<Access>;
  person: Person;
  blobs: BlobStore;
}
