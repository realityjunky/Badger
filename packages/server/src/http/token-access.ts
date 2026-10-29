import type { TokenScope } from "../tokens.js";
import { skillMethods } from "./skills.js";
import { workflowMethods } from "./workflows.js";
import { gateMethods } from "./gates.js";
import { dossierMethods } from "./dossier.js";
import { inboxMethods } from "./inbox.js";
import { sourceStudyMethods } from "./source-study.js";
import { questionnaireMethods } from "./questionnaire.js";

export function tokenRequestAllowed(
  scopes: readonly TokenScope[],
  path: string,
  method: string,
): boolean {
  const reads = method === "GET" || method === "HEAD";
  if (
    reads &&
    [
      "/api/v1/me",
      "/api/v1/me/mcp",
      "/api/v1/me/questions",
      "/api/v1/groups",
    ].includes(path)
  )
    return true;
  if (gateMethods(path) !== null)
    return reads && gateMethods(path) === "GET, HEAD";
  if (dossierMethods(path) !== null) return reads;
  if (inboxMethods(path) !== null) return reads;
  if (sourceStudyMethods(path) !== null) return reads;
  const questionnaire = questionnaireMethods(path);
  if (questionnaire !== null && questionnaire.split(", ").includes(method)) {
    if (reads) return true;
    if (/\/comments(?:\/[^/]+)?$/u.test(path))
      return scopes.includes("expert") || scopes.includes("engineer");
    if (method === "POST" && /\/concerns$/u.test(path))
      return scopes.includes("expert");
    if (/\/(answer|submit)$/u.test(path)) return scopes.includes("expert");
    // Agents draft questions, inferences, and assumptions; retiring a draft
    // removes a readiness blocker, so it stays with a signed-in person.
    return (
      scopes.includes("engineer") &&
      ((method === "POST" &&
        /\/(rounds|questions|inferences|assumptions)$/u.test(path)) ||
        (method === "PATCH" &&
          /\/(questions|inferences|assumptions)\/[^/]+$/u.test(path)))
    );
  }
  const skills = skillMethods(path);
  if (skills !== null && skills.split(", ").includes(method))
    return reads || scopes.includes("engineer") || scopes.includes("expert");
  const workflows = workflowMethods(path);
  if (workflows !== null && workflows.split(", ").includes(method))
    return (
      reads ||
      (method === "POST" &&
        /^\/api\/v1\/workflows\/[^/]+\/versions$/u.test(path) &&
        scopes.includes("engineer"))
    );
  return false;
}
