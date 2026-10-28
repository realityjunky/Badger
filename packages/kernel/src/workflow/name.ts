/** The workflow name accepted by both the kernel and its service adapters. */
export function isWorkflowName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{1,63}$/u.test(value);
}
