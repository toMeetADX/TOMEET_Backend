import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const relationshipId = `0x${"11".repeat(32)}` as const;
const partyA = `0x${"22".repeat(32)}` as const;
const partyB = `0x${"33".repeat(32)}` as const;
const confirmedAt = 1_753_488_000n;

describe("RelationshipRegistry", async () => {
  const { viem } = await network.create();
  const [admin, attester, stranger] = await viem.getWalletClients();

  async function deployRegistry() {
    return viem.deployContract("RelationshipRegistry", [
      admin.account.address,
      attester.account.address
    ]);
  }

  it("anchors a credential and exposes the stored proof", async () => {
    const registry = await deployRegistry();

    await viem.assertions.emitWithArgs(
      registry.write.createRelationship(
        [relationshipId, partyA, partyB, confirmedAt],
        { account: attester.account }
      ),
      registry,
      "RelationshipCreated",
      [relationshipId, partyA, partyB, confirmedAt, attester.account.address]
    );

    const credential = await registry.read.getCredential([relationshipId]);
    assert.equal(credential.partyACommitment, partyA);
    assert.equal(credential.partyBCommitment, partyB);
    assert.equal(credential.confirmedAt, confirmedAt);
    assert.equal(credential.revokedAt, 0n);
  });

  it("is idempotent for an identical anchor request", async () => {
    const registry = await deployRegistry();
    await registry.write.createRelationship(
      [relationshipId, partyA, partyB, confirmedAt],
      { account: attester.account }
    );
    await registry.write.createRelationship(
      [relationshipId, partyA, partyB, confirmedAt],
      { account: attester.account }
    );
    assert.equal(await registry.read.relationshipExists([relationshipId]), true);
  });

  it("rejects a conflicting duplicate and an unauthorized writer", async () => {
    const registry = await deployRegistry();
    await registry.write.createRelationship(
      [relationshipId, partyA, partyB, confirmedAt],
      { account: attester.account }
    );

    await viem.assertions.revertWithCustomError(
      registry.write.createRelationship(
        [relationshipId, partyA, `0x${"44".repeat(32)}`, confirmedAt],
        { account: attester.account }
      ),
      registry,
      "CredentialConflict"
    );
    await viem.assertions.revertWithCustomError(
      registry.write.createRelationship(
        [`0x${"55".repeat(32)}`, partyA, partyB, confirmedAt],
        { account: stranger.account }
      ),
      registry,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("revokes an existing credential idempotently", async () => {
    const registry = await deployRegistry();
    await registry.write.createRelationship(
      [relationshipId, partyA, partyB, confirmedAt],
      { account: attester.account }
    );
    await registry.write.revokeRelationship([relationshipId], {
      account: attester.account
    });
    await registry.write.revokeRelationship([relationshipId], {
      account: attester.account
    });

    const credential = await registry.read.getCredential([relationshipId]);
    assert.ok(credential.revokedAt > 0n);
  });
});
