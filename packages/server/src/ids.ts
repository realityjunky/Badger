import { randomUUID } from "node:crypto";

/** The source of record identifiers. Tests replace it with a fixed sequence. */
export interface IdSource {
  next(): string;
}

export const randomIdSource: IdSource = {
  next: () => randomUUID(),
};
