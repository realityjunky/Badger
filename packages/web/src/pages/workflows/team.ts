import type { WorkflowBinding } from "../../api/workflows.js";

export interface WorkflowTeamMember {
  key: string;
  email: string;
  displayName: string | null;
  bindings: WorkflowBinding[];
}

export function groupWorkflowBindings(
  bindings: readonly WorkflowBinding[],
): WorkflowTeamMember[] {
  const members = new Map<string, WorkflowTeamMember>();
  for (const binding of bindings) {
    const key =
      binding.personId === null
        ? `email:${binding.email.trim().toLowerCase()}`
        : `person:${binding.personId}`;
    const member = members.get(key);
    if (member === undefined) {
      members.set(key, {
        key,
        email: binding.email,
        displayName: binding.displayName,
        bindings: [binding],
      });
    } else {
      member.bindings.push(binding);
    }
  }
  return [...members.values()];
}
