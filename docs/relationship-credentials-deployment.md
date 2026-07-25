# Relationship credentials deployment

The relationship feature is a social credential system, not a wallet product.
Users never connect a wallet, hold INJ, see balances, or initiate transfers. A dedicated
server-side relayer only pays the network gas required to anchor and revoke credentials.

## Deployment order

1. Apply `20260726030000_relationship_credentials.sql` and
   `20260726031000_relationship_qr_session_ambiguity_fix.sql` to the canonical Supabase project.
2. Fund the dedicated testnet relayer with enough testnet INJ for gas.
3. Deploy `RelationshipRegistry` with `pnpm contracts:deploy:testnet`.
4. Verify the deployment transaction on Injective Testnet Blockscout and record the contract
   address plus deployment block.
5. Configure and deploy `@tomeet/relationship-worker` with `railway.relationship.toml`.
6. Deploy Rendez-Web after confirming its production Supabase URL and anon key point to the
   same canonical project.

## Relationship Worker variables

```text
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only>
INJECTIVE_EVM_RPC_URL=https://k8s.testnet.json-rpc.injective.network/
INJECTIVE_EVM_CHAIN_ID=1439
INJECTIVE_EVM_EXPLORER_URL=https://testnet.blockscout.injective.network/
RELATIONSHIP_REGISTRY_ADDRESS=0x<contract>
RELATIONSHIP_RELAYER_PRIVATE_KEY=0x<server-only-private-key>
RELATIONSHIP_REGISTRY_DEPLOYMENT_BLOCK=<block-number>
RELATIONSHIP_WORKER_POLL_INTERVAL_MS=1000
```

Never put the service-role key or relayer key in Rendez-Web, Vercel `NEXT_PUBLIC_*` variables,
browser storage, logs, screenshots, or source control.

The Injective testnet deployment parameters are committed in
`ignition/parameters.injective-testnet.json`; they contain public admin and attester addresses
only. The corresponding private keys must remain in a secure secret store. The production
Railway service receives only the relayer/attester private key.

Current Injective EVM testnet deployment:

```text
Contract: 0xeD8403CC4611Cf661CfA067ADa4242Cc65F5b234
Deployment block: 134682766
Admin: 0xBcC7022199AC782fc8B180771719638a3409D269
Attester: 0x91975AfdE5A2Fb3BbC4feeea0fe235d77B0b7112
```

## Acceptance check

Use two real authenticated accounts:

1. User A opens Profile and displays the dynamic QR code.
2. User B scans it and submits the friend request.
3. User A receives the request in real time and confirms it.
4. Both profiles show a pending credential, followed by an on-chain credential with a verified
   Blockscout transaction link.
5. The all-time Must-Meet List updates without reloading.
6. Hiding either profile removes it from the public list in real time.
7. Revoking the relationship produces an on-chain revocation and removes it from ranking totals.

The UI must contain only social surfaces: QR, scan confirmation, relationship status,
credential proof, visibility control, and leaderboard. Do not add wallet, balance, token,
deposit, transfer, trading, yield, or other financial controls.
