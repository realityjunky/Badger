export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface HomePageInput {
  displayName: string;
  email: string;
  roles: readonly string[];
  revision: string;
}

function document(title: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main>
${main}
</main>
</body>
</html>
`;
}

export function renderHomePage(input: HomePageInput): string {
  const role =
    input.roles.length === 0 ? "No role assigned" : input.roles.join(", ");
  return document(
    "Badger",
    `<h1>Badger</h1>
<p>Signed in as <strong>${escapeHtml(input.displayName)}</strong> (${escapeHtml(input.email)}).</p>
<p>Role: ${escapeHtml(role)}</p>
<p>Server revision: <code>${escapeHtml(input.revision)}</code></p>`,
  );
}

export function renderSignedOutPage(signInUrl?: string): string {
  return document(
    "Badger — not signed in",
    `<h1>Badger</h1>
<p>Not signed in.</p>${signInUrl === undefined ? "" : `\n<p><a href="${escapeHtml(signInUrl)}">Sign in with your organization</a></p>`}`,
  );
}

/** A failed browser sign-in says what happened and offers a fresh start. */
export function renderSignInFailedPage(
  message: string,
  signInUrl: string,
): string {
  return document(
    "Badger — sign-in failed",
    `<h1>Badger</h1>
<p>${escapeHtml(message)}</p>
<p><a href="${escapeHtml(signInUrl)}">Sign in again</a></p>`,
  );
}
