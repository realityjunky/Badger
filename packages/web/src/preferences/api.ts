import { apiUrl } from "../app/paths.js";
import {
  DEFAULT_PREFERENCES,
  parseStoredPreferences,
  preferencesWrite,
  type StoredPreferences,
} from "./model.js";

export interface Person {
  displayName: string;
  email: string;
  roles: readonly string[];
}

export type SaveOutcome =
  | { kind: "saved"; preferences: StoredPreferences }
  | { kind: "conflict"; preferences: StoredPreferences }
  | { kind: "failed" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function preferencesFrom(
  response: Response,
): Promise<StoredPreferences | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return isRecord(body) ? parseStoredPreferences(body["preferences"]) : null;
}

/** Reads the person's choices; a failed read leaves the defaults standing. */
export async function loadPreferences(
  basePath: string,
  signal?: AbortSignal,
): Promise<StoredPreferences> {
  const response = await fetch(apiUrl(basePath, "/me/preferences"), {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`The service answered ${response.status}`);
  }
  return (await preferencesFrom(response)) ?? DEFAULT_PREFERENCES;
}

/** Saves the person's choices, quoting the revision they were read at. */
export async function savePreferencesRequest(
  basePath: string,
  preferences: StoredPreferences,
): Promise<SaveOutcome> {
  const response = await fetch(apiUrl(basePath, "/me/preferences"), {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(preferencesWrite(preferences)),
  });
  if (response.status === 200) {
    const saved = await preferencesFrom(response);
    return saved === null
      ? { kind: "failed" }
      : { kind: "saved", preferences: saved };
  }
  if (response.status === 409) {
    const current = await preferencesFrom(response);
    return current === null
      ? { kind: "failed" }
      : { kind: "conflict", preferences: current };
  }
  return { kind: "failed" };
}

/** The signed-in person, for the user menu and the greeting. */
export async function loadPerson(
  basePath: string,
  signal?: AbortSignal,
): Promise<Person | null> {
  const response = await fetch(apiUrl(basePath, "/me"), {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || !isRecord(body["person"])) {
    return null;
  }
  const person = body["person"];
  if (typeof person["displayName"] !== "string") {
    return null;
  }
  return {
    displayName: person["displayName"],
    email: typeof person["email"] === "string" ? person["email"] : "",
    roles: Array.isArray(person["roles"])
      ? person["roles"].filter(
          (role): role is string => typeof role === "string",
        )
      : [],
  };
}
