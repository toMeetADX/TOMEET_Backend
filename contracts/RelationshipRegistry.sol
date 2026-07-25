// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title TOMEET Relationship Registry
/// @notice Stores privacy-preserving, non-transferable relationship attestations.
contract RelationshipRegistry is AccessControl, Pausable {
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");

    struct Credential {
        bytes32 partyACommitment;
        bytes32 partyBCommitment;
        uint64 confirmedAt;
        uint64 revokedAt;
    }

    mapping(bytes32 relationshipId => Credential credential) private credentials;

    error InvalidAddress();
    error InvalidRelationship();
    error CredentialConflict(bytes32 relationshipId);
    error CredentialNotFound(bytes32 relationshipId);

    event RelationshipCreated(
        bytes32 indexed relationshipId,
        bytes32 indexed partyACommitment,
        bytes32 indexed partyBCommitment,
        uint64 confirmedAt,
        address attester
    );
    event RelationshipRevoked(
        bytes32 indexed relationshipId,
        uint64 revokedAt,
        address attester
    );

    constructor(address admin, address attester) {
        if (admin == address(0) || attester == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTER_ROLE, attester);
    }

    function createRelationship(
        bytes32 relationshipId,
        bytes32 partyACommitment,
        bytes32 partyBCommitment,
        uint64 confirmedAt
    ) external onlyRole(ATTESTER_ROLE) whenNotPaused {
        if (
            relationshipId == bytes32(0) ||
            partyACommitment == bytes32(0) ||
            partyBCommitment == bytes32(0) ||
            partyACommitment == partyBCommitment ||
            confirmedAt == 0
        ) revert InvalidRelationship();

        Credential storage existing = credentials[relationshipId];
        if (existing.confirmedAt != 0) {
            if (
                existing.partyACommitment == partyACommitment &&
                existing.partyBCommitment == partyBCommitment &&
                existing.confirmedAt == confirmedAt
            ) return;
            revert CredentialConflict(relationshipId);
        }

        credentials[relationshipId] = Credential({
            partyACommitment: partyACommitment,
            partyBCommitment: partyBCommitment,
            confirmedAt: confirmedAt,
            revokedAt: 0
        });

        emit RelationshipCreated(
            relationshipId,
            partyACommitment,
            partyBCommitment,
            confirmedAt,
            msg.sender
        );
    }

    function revokeRelationship(bytes32 relationshipId)
        external
        onlyRole(ATTESTER_ROLE)
        whenNotPaused
    {
        Credential storage credential = credentials[relationshipId];
        if (credential.confirmedAt == 0) revert CredentialNotFound(relationshipId);
        if (credential.revokedAt != 0) return;

        credential.revokedAt = uint64(block.timestamp);
        emit RelationshipRevoked(relationshipId, credential.revokedAt, msg.sender);
    }

    function getCredential(bytes32 relationshipId)
        external
        view
        returns (Credential memory)
    {
        return credentials[relationshipId];
    }

    function relationshipExists(bytes32 relationshipId) external view returns (bool) {
        return credentials[relationshipId].confirmedAt != 0;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
