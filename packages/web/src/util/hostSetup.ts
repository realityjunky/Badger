/**
 * Host setup text for the dashboard. A deployment URL or command that the host
 * configuration refuses, such as a plain-HTTP origin the server allows, comes
 * back as the reason instead of throwing while a page renders.
 */
export type HostSetupText =
  { text: string; failure: null } | { text: ""; failure: string };

export function hostSetupText(render: () => string): HostSetupText {
  try {
    return { text: render(), failure: null };
  } catch (error) {
    return {
      text: "",
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}
