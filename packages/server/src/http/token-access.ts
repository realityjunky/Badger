import type { TokenScope } from "../tokens.js";
import { skillMethods } from "./skills.js";
import { workflowMethods } from "./workflows.js";
import { gateMethods } from "./gates.js";
import { inboxMethods } from "./inbox.js";
import { sourceStudyMethods } from "./source-study.js";

export function tokenRequestAllowed(
  scopes: readonly TokenScope[],
  path: string,
  method: string,
): boolean {
  const reads = method === "GET" || method === "HEAD";
  if (reads && ["/api/v1/me", "/api/v1/groups"].includes(path)) return true;
  if (gateMethods(path) !== null)
    return reads && gateMethods(path) === "GET, HEAD";
  if (inboxMethods(path) !== null) return reads;
  if (sourceStudyMethods(path) !== null) return reads;
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
