import type { CompositeReadiness, PackageSnapshot } from "@realityjunky/badger";
export interface PublishedPackage {
  id: string;
  workflowVersionId: string;
  versionNumber: number;
  semanticVersion?: string | null;
  versionName: string;
  reviewId: string;
  packageId: string;
  packageHash: string;
  publisherId: string;
  publisherName: string;
  publishedAt: string;
  fileCount: number;
}
export interface ReviewView {
  currentPackageHash: string | null;
  passingReportId: string | null;
  approvalId: string | null;
  readiness: CompositeReadiness | null;
  canPublish: boolean;
  reviews: {
    id: string;
    packageHash: string;
    reviewerName: string;
    approvedAt: string;
    overrideReason: string | null;
    invalidatedAt: string | null;
    invalidationReason: string | null;
  }[];
  publications: PublishedPackage[];
}
export interface PublishedPackageRead {
  publication: PublishedPackage;
  snapshot: PackageSnapshot;
}
