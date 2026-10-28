export class RequestError extends Error {
  /**
   * `details` are extra top-level fields for the error response, such as the
   * current state a conflicting write should reconsider.
   */
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 413,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export function objectInput(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestError(400, "The request body must be an object");
  }
  return value as Record<string, unknown>;
}
