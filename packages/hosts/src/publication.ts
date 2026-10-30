import {
  verifyPackageSnapshot,
  type PackageSnapshot,
} from "@realityjunky/badger";
import { deploymentUrl } from "./configuration.js";
import type { PublishedIdentity } from "./index.js";
export interface PublishedPackageRead {
  publication: { id: string; packageHash: string };
  snapshot: PackageSnapshot;
}
export function verifyPublishedPackage(
  value: PublishedPackageRead,
  expected: PublishedIdentity,
): PackageSnapshot {
  if (
    value?.publication?.id !== expected.publicationId ||
    value.publication.packageHash !== expected.packageHash ||
    value.snapshot?.packageHash !== expected.packageHash
  )
    throw new Error(
      "Published package identity does not match the selected version",
    );
  return verifyPackageSnapshot(value.snapshot);
}
export function publishedPackagePath(identity: PublishedIdentity): string {
  return `/workflows/${encodeURIComponent(identity.workflowId)}/publications/${encodeURIComponent(identity.publicationId)}/package?packageHash=${encodeURIComponent(identity.packageHash)}`;
}
export async function downloadPublishedPackage(
  options: { url: string; token: string; agentHost?: string },
  identity: PublishedIdentity,
): Promise<PackageSnapshot> {
  const url = deploymentUrl(options.url);
  if (!options.token)
    throw new Error("Set BADGER_TOKEN in the local environment");
  let response: Response;
  try {
    response = await fetch(`${url}/api/v1${publishedPackagePath(identity)}`, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${options.token}`,
        "x-badger-agent-host": options.agentHost ?? "Badger hosts CLI",
      },
    });
  } catch {
    throw new Error(
      "Cannot fetch the published package; check the deployment URL and connection",
    );
  }
  if (!response.ok)
    throw new Error(
      `Published package request refused (${response.status}); check access and the selected hash`,
    );
  // Bound memory before parsing an untrusted deployment response.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Published package response is empty");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024 * 1024)
        throw new Error("Published package is too large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  let value: PublishedPackageRead;
  try {
    value = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as PublishedPackageRead;
  } catch {
    throw new Error("Invalid published package response");
  }
  return verifyPublishedPackage(value, identity);
}
