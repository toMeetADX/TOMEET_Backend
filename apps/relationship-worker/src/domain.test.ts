import { describe, expect, it } from "vitest";
import {
  asBytes32,
  decideChainAction,
  relationshipJobSchema,
  type RelationshipJob
} from "./domain.js";

const job: RelationshipJob = {
  job_id: "10000000-0000-4000-8000-000000000001",
  action: "anchor",
  credential_id: "20000000-0000-4000-8000-000000000002",
  relationship_hash: "11".repeat(32),
  party_a_commitment: "22".repeat(32),
  party_b_commitment: "33".repeat(32),
  confirmed_at: "2026-07-26T01:00:00.000Z",
  attempt: 1
};

describe("relationship worker domain", () => {
  it("parses a valid claimed job and rejects malformed hashes", () => {
    expect(relationshipJobSchema.parse(job)).toEqual(job);
    expect(() => relationshipJobSchema.parse({ ...job, relationship_hash: "not-a-hash" })).toThrow();
  });

  it("submits a missing anchor and recovers an identical existing anchor", () => {
    const missing = {
      partyACommitment: asBytes32("00".repeat(32)),
      partyBCommitment: asBytes32("00".repeat(32)),
      confirmedAt: 0n,
      revokedAt: 0n
    };
    expect(decideChainAction(job, missing)).toBe("submit_anchor");

    const existing = {
      partyACommitment: asBytes32(job.party_a_commitment),
      partyBCommitment: asBytes32(job.party_b_commitment),
      confirmedAt: 1_785_027_600n,
      revokedAt: 0n
    };
    expect(decideChainAction(job, existing)).toBe("already_anchored");
  });

  it("rejects conflicting anchors", () => {
    const conflict = {
      partyACommitment: asBytes32("44".repeat(32)),
      partyBCommitment: asBytes32(job.party_b_commitment),
      confirmedAt: 1_785_027_600n,
      revokedAt: 0n
    };
    expect(() => decideChainAction(job, conflict)).toThrow("conflicts");
  });

  it("distinguishes pending and completed revocations", () => {
    const revokeJob = { ...job, action: "revoke" as const };
    const anchored = {
      partyACommitment: asBytes32(job.party_a_commitment),
      partyBCommitment: asBytes32(job.party_b_commitment),
      confirmedAt: 1_785_027_600n,
      revokedAt: 0n
    };
    expect(decideChainAction(revokeJob, anchored)).toBe("submit_revoke");
    expect(decideChainAction(revokeJob, { ...anchored, revokedAt: 1n })).toBe("already_revoked");
    expect(() => decideChainAction(revokeJob, { ...anchored, confirmedAt: 0n })).toThrow("not anchored");
  });
});
