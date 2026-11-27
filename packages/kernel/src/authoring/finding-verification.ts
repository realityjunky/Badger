import type {
  WorkflowDurabilityProfile,
  WorkflowProtocol,
  WorkflowVerifierPin,
} from "../types.js";
import { compileWorkflow } from "../workflow-runtime/compiler.js";
import {
  assertWorkflowVerifierSignature,
  parseWorkflowVerificationReceipt,
} from "../workflow-runtime/verification-receipts.js";

export interface FindingVerifierBinding {
  nodeId: string;
  requirementId: string;
  role: string;
  pin: WorkflowVerifierPin;
  profile: WorkflowDurabilityProfile;
  protocolHash: string;
  runtimePackageHash: string;
}

export async function bindFindingVerifier(
  protocol: WorkflowProtocol,
  selector: { nodeId: string; requirementId: string },
): Promise<FindingVerifierBinding> {
  const node = protocol.nodes.find(
    (candidate) => candidate.id === selector.nodeId && !candidate.disabled,
  );
  const guard = node?.guardrails.find(
    (candidate) =>
      (candidate.verification?.id ?? candidate.id) === selector.requirementId,
  );
  const requirement = guard?.verification;
  if (!requirement?.verifierPin)
    throw new Error(
      "The approved protocol must bind the checker fingerprint and public key for this requirement",
    );
  const { identity } = await compileWorkflow(protocol);
  if (!identity.durabilityProfile)
    throw new Error("This protocol does not provide verification receipts");
  return {
    ...selector,
    role: requirement.role,
    pin: requirement.verifierPin,
    profile: identity.durabilityProfile,
    protocolHash: identity.protocolHash,
    runtimePackageHash: identity.packageHash,
  };
}

export function verifyFindingReceipt(
  binding: FindingVerifierBinding,
  subjectHash: string,
  value: unknown,
) {
  const receipt = parseWorkflowVerificationReceipt(value, binding.profile);
  if (
    receipt.receiptKind !== "automated-check" ||
    receipt.status !== "passed" ||
    receipt.protocolHash !== binding.protocolHash ||
    receipt.packageHash !== binding.runtimePackageHash ||
    receipt.nodeId !== binding.nodeId ||
    receipt.requirementId !== binding.requirementId ||
    receipt.role !== binding.role
  )
    throw new Error(
      "The verification receipt does not match the approved check",
    );
  assertWorkflowVerifierSignature(binding.pin, receipt);
  const checkedHashes = [
    receipt.evidence.outputHash,
    ...receipt.scope.artifacts.map((artifact) => artifact.contentHash),
    ...receipt.scope.evidence.map((evidence) => evidence.contentHash),
  ];
  if (!checkedHashes.includes(subjectHash))
    throw new Error(
      "The signed result must cover the dispatched target digest",
    );
  return receipt.receiptHash;
}
