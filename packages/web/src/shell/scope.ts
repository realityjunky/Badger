export interface ScopeSelection {
  group?: string;
  workflow?: string;
  version?: string;
}

export function scopeSelection(
  pathname: string,
  search: string,
): ScopeSelection {
  const parameters = new URLSearchParams(search);
  const path = /^\/workflows\/([^/]+)(?:\/versions\/([^/]+))?$/u.exec(pathname);
  const decode = (value: string | undefined) => {
    try {
      return value === undefined ? undefined : decodeURIComponent(value);
    } catch {
      return undefined;
    }
  };
  return {
    group: parameters.get("group") ?? undefined,
    workflow: path?.[1]
      ? decode(path[1])
      : (parameters.get("workflow") ?? undefined),
    version: path?.[2]
      ? decode(path[2])
      : (parameters.get("version") ?? undefined),
  };
}

export function scopeDestination(
  pathname: string,
  scope: ScopeSelection,
): string {
  if (pathname.startsWith("/skills"))
    return `/skills${scope.group ? `?group=${encodeURIComponent(scope.group)}` : ""}`;
  if (!scope.workflow)
    return `/workflows${scope.group ? `?group=${encodeURIComponent(scope.group)}` : ""}`;
  const page = ["/questionnaire", "/evaluations", "/runs"].find(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (page) {
    const parameters = new URLSearchParams({ workflow: scope.workflow });
    if (scope.version && page !== "/runs")
      parameters.set("version", scope.version);
    return `${page}?${parameters}`;
  }
  return `/workflows/${encodeURIComponent(scope.workflow)}${scope.version ? `/versions/${encodeURIComponent(scope.version)}` : ""}`;
}
