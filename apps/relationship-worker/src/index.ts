import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  asBytes32,
  confirmedAtSeconds,
  decideChainAction,
  relationshipJobSchema,
  type RelationshipJob
} from "./domain.js";
import { createWorkerHealthServer } from "./health-server.js";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env"), override: false });

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  INJECTIVE_EVM_RPC_URL: z.string().url().default("https://k8s.testnet.json-rpc.injective.network/"),
  INJECTIVE_EVM_CHAIN_ID: z.coerce.number().int().positive().default(1439),
  INJECTIVE_EVM_EXPLORER_URL: z.string().url().default("https://testnet.blockscout.injective.network/"),
  RELATIONSHIP_REGISTRY_ADDRESS: z.string().refine(isAddress, "Invalid registry address"),
  RELATIONSHIP_RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/u),
  RELATIONSHIP_REGISTRY_DEPLOYMENT_BLOCK: z.coerce.bigint().nonnegative().default(0n),
  RELATIONSHIP_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1000),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080)
});

const env = envSchema.parse(process.env);
const account = privateKeyToAccount(env.RELATIONSHIP_RELAYER_PRIVATE_KEY as Hex);
const registryAddress = env.RELATIONSHIP_REGISTRY_ADDRESS as Address;
const chain = defineChain({
  id: env.INJECTIVE_EVM_CHAIN_ID,
  name: env.INJECTIVE_EVM_CHAIN_ID === 1776 ? "Injective EVM" : "Injective EVM Testnet",
  nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
  rpcUrls: { default: { http: [env.INJECTIVE_EVM_RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: env.INJECTIVE_EVM_EXPLORER_URL } }
});
const publicClient = createPublicClient({ chain, transport: http(env.INJECTIVE_EVM_RPC_URL) });
const walletClient = createWalletClient({ account, chain, transport: http(env.INJECTIVE_EVM_RPC_URL) });
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const workerId = `${process.env.RAILWAY_REPLICA_ID ?? "local"}:${randomUUID().slice(0, 8)}`;
const abortController = new AbortController();

const relationshipRegistryAbi = [
  {
    type: "function",
    name: "createRelationship",
    stateMutability: "nonpayable",
    inputs: [
      { name: "relationshipId", type: "bytes32" },
      { name: "partyACommitment", type: "bytes32" },
      { name: "partyBCommitment", type: "bytes32" },
      { name: "confirmedAt", type: "uint64" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "revokeRelationship",
    stateMutability: "nonpayable",
    inputs: [{ name: "relationshipId", type: "bytes32" }],
    outputs: []
  },
  {
    type: "function",
    name: "getCredential",
    stateMutability: "view",
    inputs: [{ name: "relationshipId", type: "bytes32" }],
    outputs: [{
      name: "",
      type: "tuple",
      components: [
        { name: "partyACommitment", type: "bytes32" },
        { name: "partyBCommitment", type: "bytes32" },
        { name: "confirmedAt", type: "uint64" },
        { name: "revokedAt", type: "uint64" }
      ]
    }]
  },
  {
    type: "event",
    name: "RelationshipCreated",
    inputs: [
      { name: "relationshipId", type: "bytes32", indexed: true },
      { name: "partyACommitment", type: "bytes32", indexed: true },
      { name: "partyBCommitment", type: "bytes32", indexed: true },
      { name: "confirmedAt", type: "uint64", indexed: false },
      { name: "attester", type: "address", indexed: false }
    ]
  },
  {
    type: "event",
    name: "RelationshipRevoked",
    inputs: [
      { name: "relationshipId", type: "bytes32", indexed: true },
      { name: "revokedAt", type: "uint64", indexed: false },
      { name: "attester", type: "address", indexed: false }
    ]
  }
] as const;

async function claimJob(): Promise<RelationshipJob | null> {
  const { data, error } = await supabase.rpc("claim_relationship_onchain_job", {
    p_worker_id: workerId
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? relationshipJobSchema.parse(row) : null;
}

async function findExistingTransaction(job: RelationshipJob): Promise<{
  transactionHash: Hex;
  blockNumber: bigint;
} | null> {
  const eventName = job.action === "anchor" ? "RelationshipCreated" : "RelationshipRevoked";
  const events = await publicClient.getContractEvents({
    address: registryAddress,
    abi: relationshipRegistryAbi,
    eventName,
    args: { relationshipId: asBytes32(job.relationship_hash) },
    fromBlock: env.RELATIONSHIP_REGISTRY_DEPLOYMENT_BLOCK,
    toBlock: "latest",
    strict: true
  });
  const event = events.at(-1);
  return event?.transactionHash && event.blockNumber !== null
    ? { transactionHash: event.transactionHash, blockNumber: event.blockNumber }
    : null;
}

async function submitJob(job: RelationshipJob): Promise<{ transactionHash: Hex; blockNumber: bigint }> {
  const relationshipId = asBytes32(job.relationship_hash);
  const credential = await publicClient.readContract({
    address: registryAddress,
    abi: relationshipRegistryAbi,
    functionName: "getCredential",
    args: [relationshipId]
  });

  const confirmedAt = confirmedAtSeconds(job.confirmed_at);
  const decision = decideChainAction(job, credential);
  if (decision === "already_anchored") {
    const existing = await findExistingTransaction(job);
    if (!existing) throw new Error("Credential exists but creation event was not found");
    return existing;
  }
  if (decision === "already_revoked") {
    const existing = await findExistingTransaction(job);
    if (!existing) throw new Error("Credential is revoked but revocation event was not found");
    return existing;
  }

  let transactionHash: Hex;
  if (decision === "submit_anchor") {
    const simulation = await publicClient.simulateContract({
      account,
      address: registryAddress,
      abi: relationshipRegistryAbi,
      functionName: "createRelationship",
      args: [
        relationshipId,
        asBytes32(job.party_a_commitment),
        asBytes32(job.party_b_commitment),
        confirmedAt
      ]
    });
    transactionHash = await walletClient.writeContract(simulation.request);
  } else {
    const simulation = await publicClient.simulateContract({
      account,
      address: registryAddress,
      abi: relationshipRegistryAbi,
      functionName: "revokeRelationship",
      args: [relationshipId]
    });
    transactionHash = await walletClient.writeContract(simulation.request);
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${transactionHash}`);
  return { transactionHash, blockNumber: receipt.blockNumber };
}

async function completeJob(job: RelationshipJob, result: { transactionHash: Hex; blockNumber: bigint }) {
  const { error } = await supabase.rpc("complete_relationship_onchain_job", {
    p_job_id: job.job_id,
    p_worker_id: workerId,
    p_tx_hash: result.transactionHash,
    p_block_number: Number(result.blockNumber),
    p_chain_id: env.INJECTIVE_EVM_CHAIN_ID,
    p_contract_address: registryAddress
  });
  if (error) throw error;
}

async function failJob(job: RelationshipJob, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const { error: rpcError } = await supabase.rpc("fail_relationship_onchain_job", {
    p_job_id: job.job_id,
    p_worker_id: workerId,
    p_error: message
  });
  if (rpcError) throw rpcError;
  console.error(JSON.stringify({
    level: "error", event: "relationship_anchor_failed", jobId: job.job_id,
    credentialId: job.credential_id, action: job.action, attempt: job.attempt, error: message
  }));
}

const delay = (milliseconds: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function runWorker() {
  while (!abortController.signal.aborted) {
    let job: RelationshipJob | null = null;
    try {
      job = await claimJob();
      if (!job) {
        await delay(env.RELATIONSHIP_WORKER_POLL_INTERVAL_MS);
        continue;
      }
      const result = await submitJob(job);
      await completeJob(job, result);
      console.info(JSON.stringify({
        level: "info", event: "relationship_anchor_completed", jobId: job.job_id,
        credentialId: job.credential_id, action: job.action,
        transactionHash: result.transactionHash, blockNumber: result.blockNumber.toString()
      }));
    } catch (error) {
      if (job) {
        try { await failJob(job, error); }
        catch (failError) {
          console.error(JSON.stringify({
            level: "error", event: "relationship_job_failure_persist_failed",
            error: failError instanceof Error ? failError.message : String(failError)
          }));
        }
      } else {
        console.error(JSON.stringify({
          level: "error", event: "relationship_worker_loop_error",
          error: error instanceof Error ? error.message : String(error)
        }));
      }
      await delay(Math.min(env.RELATIONSHIP_WORKER_POLL_INTERVAL_MS * 2, 5000));
    }
  }
}

const healthServer = createWorkerHealthServer({
  service: "tomeet-relationship-worker",
  port: env.PORT,
  ping: async () => {
    const [{ error }, chainId] = await Promise.all([
      supabase.from("relationship_onchain_jobs").select("id", { head: true, count: "exact" }).limit(1),
      publicClient.getChainId()
    ]);
    if (error) throw error;
    if (chainId !== env.INJECTIVE_EVM_CHAIN_ID) throw new Error("Unexpected Injective chain ID");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    healthServer.setReady(false);
    abortController.abort();
  });
}

await healthServer.listen();
try {
  await publicClient.getBlockNumber();
  healthServer.setReady(true);
  console.info(JSON.stringify({
    level: "info", event: "relationship_worker_started", workerId,
    chainId: env.INJECTIVE_EVM_CHAIN_ID, registryAddress, relayerAddress: account.address
  }));
  await runWorker();
} finally {
  healthServer.setReady(false);
  await healthServer.close();
}
