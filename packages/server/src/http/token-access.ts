import type { TokenScope } from "../tokens.js";
import { skillMethods } from "./skills.js";
import { workflowMethods } from "./workflows.js";

export function tokenRequestAllowed(
  scopes: readonly TokenScope[],
  path: string,
  method: string,
): boolean {
  const reads = method === "GET" || method === "HEAD";
  if (reads && ["/api/v1/me", "/api/v1/groups"].includes(path)) return true;
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
