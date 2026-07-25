import type { Hex } from "viem";
import { z } from "zod";

export const relationshipJobSchema = z.object({
  job_id: z.string().uuid(),
  action: z.enum(["anchor", "revoke"]),
  credential_id: z.string().uuid(),
  relationship_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  party_a_commitment: z.string().regex(/^[0-9a-f]{64}$/u),
  party_b_commitment: z.string().regex(/^[0-9a-f]{64}$/u),
  confirmed_at: z.string().datetime({ offset: true }),
  attempt: z.number().int().positive()
});

export type RelationshipJob = z.infer<typeof relationshipJobSchema>;

export type OnchainCredential = {
  partyACommitment: Hex;
  partyBCommitment: Hex;
  confirmedAt: bigint;
  revokedAt: bigint;
};

export type ChainDecision =
  | "submit_anchor"
  | "already_anchored"
  | "submit_revoke"
  | "already_revoked";

export function asBytes32(value: string): Hex {
  return `0x${value}` as Hex;
}

export function confirmedAtSeconds(confirmedAt: string): bigint {
  const milliseconds = new Date(confirmedAt).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid confirmation time");
  return BigInt(Math.floor(milliseconds / 1000));
}

export function decideChainAction(
  job: RelationshipJob,
  credential: OnchainCredential
): ChainDecision {
  const expectedConfirmedAt = confirmedAtSeconds(job.confirmed_at);

  if (job.action === "anchor") {
    if (credential.confirmedAt === 0n) return "submit_anchor";
    if (
      credential.partyACommitment !== asBytes32(job.party_a_commitment) ||
      credential.partyBCommitment !== asBytes32(job.party_b_commitment) ||
      credential.confirmedAt !== expectedConfirmedAt
    ) {
      throw new Error("On-chain credential conflicts with Supabase state");
    }
    return "already_anchored";
  }

  if (credential.confirmedAt === 0n) {
    throw new Error("Cannot revoke a credential that is not anchored");
  }
  return credential.revokedAt === 0n ? "submit_revoke" : "already_revoked";
}
