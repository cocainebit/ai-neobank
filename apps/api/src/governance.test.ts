import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { createPostgresJobQueue, createPostgresStore } from "@ai-neobank/database";
import { createWorker } from "@ai-neobank/worker";
import { deploySafeProtocolFixture, type SafeContractAddresses } from "@ai-neobank/safe-adapter";
import { SquadsGovernanceAdapter } from "@ai-neobank/squads-adapter";
import { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { signSolanaMessage } from "@ai-neobank/auth";
import { buildApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const solanaRpc = process.env.SOLANA_RPC_URL;
const enabled = process.env.RUN_API_INTEGRATION === "1" && databaseUrl && evmRpc && solanaRpc;
const testIf = enabled ? it : it.skip;
const masterKey = new Uint8Array(32).fill(9);
const evmNetwork = "eip155:31337" as const;
const solNetwork = "solana:localnet" as const;
const domain = "relay.test";
const uri = "http://relay.test";

let contracts: SafeContractAddresses | undefined;
let app: ReturnType<typeof buildApp> | null = null;
let runtime: ReturnType<typeof createWorker> | null = null;
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // Anvil's default funded account

beforeAll(async () => {
  if (!enabled) return;
  contracts = await deploySafeProtocolFixture(evmRpc!, 31337, "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const chains = { evm: { rpcUrl: evmRpc!, chainId: 31337, network: evmNetwork, safeContracts: contracts }, solana: { rpcUrl: solanaRpc!, network: solNetwork, finality: "finalized" as const } };
  app = buildApp({ store: createPostgresStore(databaseUrl!), queue: createPostgresJobQueue(databaseUrl!), environment: "development", auth: { domain, uri }, webOrigin: uri, signerMasterKey: masterKey, allowSoftwareSigners: true, chains, logger: false });
  runtime = createWorker(databaseUrl!, { signerMasterKey: masterKey, ...chains });
  await app.ready();
});
afterAll(async () => { await app?.close(); await runtime?.close(); });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function signInEvm(account: PrivateKeyAccount) {
  const challenge = await app!.inject({ method: "POST", url: "/v1/auth/challenges", payload: { chainFamily: "evm", address: account.address, chainReference: "31337" } });
  const { nonce, message } = challenge.json().data as { nonce: string; message: string };
  const verify = await app!.inject({ method: "POST", url: "/v1/auth/verify", payload: { chainFamily: "evm", address: account.address, nonce, signature: await account.signMessage({ message }) } });
  expect(verify.statusCode).toBe(200);
  return verify.json().data as { session: { token: string }; organization: { id: string }; principal: { id: string } };
}

async function signInSolana(keypair: Keypair) {
  const address = keypair.publicKey.toBase58();
  const challenge = await app!.inject({ method: "POST", url: "/v1/auth/challenges", payload: { chainFamily: "svm", address, chainReference: "localnet" } });
  const { nonce, message } = challenge.json().data as { nonce: string; message: string };
  const verify = await app!.inject({ method: "POST", url: "/v1/auth/verify", payload: { chainFamily: "svm", address, nonce, signature: signSolanaMessage(message, keypair.secretKey) } });
  expect(verify.statusCode).toBe(200);
  return verify.json().data as { session: { token: string }; organization: { id: string }; principal: { id: string } };
}

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await response.json() as { result: unknown }).result;
}

async function untilStatus(token: string, intentId: string, wanted: string[], attempts = 80) {
  let status = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await runtime!.worker.drain();
    const detail = (await app!.inject({ method: "GET", url: `/v1/intents/${intentId}`, headers: bearer(token) })).json().data;
    status = detail.intent.status;
    if (wanted.includes(status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Intent stuck in ${status}`);
}

describe("governed treasuries over HTTP", () => {
  testIf("Safe: the owner deploys from the prepared transaction, registers with an executor, approves with typed data", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const second = privateKeyToAccount(generatePrivateKey());
    await anvil("anvil_setBalance", [owner.address, "0x56bc75e2d63100000"]);
    const session = await signInEvm(owner);
    const token = session.session.token;
    await app!.inject({ method: "POST", url: "/v1/members", headers: bearer(token), payload: { displayName: "Second owner", role: "approver", wallet: { chainFamily: "evm", address: second.address } } });
    const secondSession = await signInEvm(second);

    // Executor signer is Relay's; it must not be an owner.
    const executor = (await app!.inject({ method: "POST", url: "/v1/signers", headers: bearer(token), payload: { chainFamily: "evm" } })).json().data as { id: string; address: string };
    await anvil("anvil_setBalance", [executor.address, "0x8ac7230489e80000"]);
    const prepared = await app!.inject({ method: "POST", url: "/v1/treasuries/prepare", headers: bearer(token), payload: { governance: "safe", network: evmNetwork, owners: [owner.address, second.address], threshold: 2, executorSignerId: executor.id } });
    expect(prepared.statusCode).toBe(200);
    const deployment = prepared.json().data as { predictedAddress: string; transaction: { to: string; data: string; value: string } };

    // The owner's wallet sends the deployment; Relay only predicted it.
    const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [evmRpc!] } } });
    const wallet = createWalletClient({ account: owner, chain, transport: http(evmRpc) });
    const publicClient = createPublicClient({ chain, transport: http(evmRpc) });
    await publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: owner, to: deployment.transaction.to as Address, data: deployment.transaction.data as Hex, value: BigInt(deployment.transaction.value) }) });
    await publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: owner, to: deployment.predictedAddress as Address, value: parseEther("3") }) });

    // Registration verifies on chain: a non-owner wallet cannot register it, and the executor cannot be an owner.
    const stranger = await signInEvm(privateKeyToAccount(generatePrivateKey()));
    const strangerSigner = (await app!.inject({ method: "POST", url: "/v1/signers", headers: bearer(stranger.session.token), payload: { chainFamily: "evm" } })).json().data as { id: string };
    expect((await app!.inject({ method: "POST", url: "/v1/treasuries", headers: bearer(stranger.session.token), payload: { name: "Not mine", chainFamily: "evm", network: evmNetwork, address: deployment.predictedAddress, governance: "safe", executorSignerId: strangerSigner.id } })).statusCode).toBe(403);
    const registered = await app!.inject({ method: "POST", url: "/v1/treasuries", headers: bearer(token), payload: { name: "Ops Safe", chainFamily: "evm", network: evmNetwork, address: deployment.predictedAddress, governance: "safe", executorSignerId: executor.id } });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().data.observedConfiguration.threshold).toBe(2);
    const treasuryId = registered.json().data.id as string;

    const nativeAsset = `${evmNetwork}/slip44:60`;
    const agent = (await app!.inject({ method: "POST", url: "/v1/agents", headers: bearer(token), payload: { displayName: "Payables", purpose: "Pay vendors" } })).json().data as { id: string };
    const agentToken = (await app!.inject({ method: "POST", url: `/v1/agents/${agent.id}/credentials`, headers: bearer(token), payload: {} })).json().token as string;
    const policy = (await app!.inject({ method: "POST", url: "/v1/policies", headers: bearer(token), payload: { name: "Safe policy", definition: { maxPerTransactionBaseUnits: parseEther("2").toString(), maxDailyBaseUnits: parseEther("4").toString(), allowedNetworks: [evmNetwork], allowedAssets: [nativeAsset] } } })).json().data as { id: string };
    await app!.inject({ method: "POST", url: `/v1/policies/${policy.id}/bindings`, headers: bearer(token), payload: { agentId: agent.id } });
    const destination = privateKeyToAccount(generatePrivateKey()).address;
    const submitted = await app!.inject({ method: "POST", url: "/v1/agent/intents", headers: bearer(agentToken), payload: { idempotencyKey: `safe-${crypto.randomUUID()}`, treasuryAccountId: treasuryId, assetId: nativeAsset, amountBaseUnits: parseEther("1").toString(), destination, purpose: "Safe governed vendor payment" } });
    expect(submitted.statusCode).toBe(202);
    const intentId = submitted.json().data.id as string;
    const pending = await untilStatus(token, intentId, ["approval_required", "rejected", "failed"]);
    expect(pending.intent.status).toBe("approval_required");
    expect(pending.approval.requiredApprovals).toBe(2);

    for (const [account, sessionToken] of [[owner, token], [second, secondSession.session.token]] as const) {
      const messageResponse = await app!.inject({ method: "GET", url: `/v1/intents/${intentId}/approval-message/approved`, headers: bearer(sessionToken) });
      expect(messageResponse.json().data.kind).toBe("eip712");
      const { typedData, expectedIntentVersion, compiledHash, simulationHash } = messageResponse.json().data;
      const { EIP712Domain: _domainType, ...types } = typedData.types;
      const typed = { ...typedData, types, message: { ...typedData.message, value: BigInt(typedData.message.value), safeTxGas: BigInt(typedData.message.safeTxGas), baseGas: BigInt(typedData.message.baseGas), gasPrice: BigInt(typedData.message.gasPrice), nonce: BigInt(typedData.message.nonce) } };
      const wrongSigner = await privateKeyToAccount(generatePrivateKey()).signTypedData(typed);
      expect((await app!.inject({ method: "POST", url: `/v1/intents/${intentId}/approve`, headers: bearer(sessionToken), payload: { expectedIntentVersion, compiledHash, simulationHash, signature: wrongSigner } })).statusCode).toBe(401);
      expect((await app!.inject({ method: "POST", url: `/v1/intents/${intentId}/approve`, headers: bearer(sessionToken), payload: { expectedIntentVersion, compiledHash, simulationHash } })).statusCode).toBe(400);
      const signature = await account.signTypedData(typed);
      expect((await app!.inject({ method: "POST", url: `/v1/intents/${intentId}/approve`, headers: bearer(sessionToken), payload: { expectedIntentVersion, compiledHash, simulationHash, signature } })).statusCode).toBe(202);
    }
    const done = await untilStatus(token, intentId, ["reconciled", "failed"]);
    expect(done.intent.status).toBe("reconciled");
    expect(await publicClient.getBalance({ address: destination })).toBe(parseEther("1"));
    expect(done.execution.status).toBe("finalized");
    const balances = (await app!.inject({ method: "GET", url: `/v1/treasuries/${treasuryId}/balances`, headers: bearer(token) })).json().data.balances as { assetId: string; balanceBaseUnits: string }[];
    expect(BigInt(balances.find((entry) => entry.assetId === nativeAsset)!.balanceBaseUnits)).toBe(parseEther("2"));
  }, 180_000);

  testIf("Squads: the member creates the multisig from the prepared transaction, registers, votes on chain through the API", async () => {
    const connection = new Connection(solanaRpc!, "confirmed");
    const airdrop = async (address: PublicKey, sol: number) => {
      const signature = await connection.requestAirdrop(address, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
    };
    const owner = Keypair.generate();
    const second = Keypair.generate();
    await Promise.all([airdrop(owner.publicKey, 5), airdrop(second.publicKey, 2)]);
    const session = await signInSolana(owner);
    const token = session.session.token;
    await app!.inject({ method: "POST", url: "/v1/members", headers: bearer(token), payload: { displayName: "Second member", role: "approver", wallet: { chainFamily: "svm", address: second.publicKey.toBase58() } } });
    const secondSession = await signInSolana(second);

    const executor = (await app!.inject({ method: "POST", url: "/v1/signers", headers: bearer(token), payload: { chainFamily: "svm" } })).json().data as { id: string; address: string };
    await airdrop(new PublicKey(executor.address), 2);
    const prepared = await app!.inject({ method: "POST", url: "/v1/treasuries/prepare", headers: bearer(token), payload: { governance: "squads", network: solNetwork, owners: [owner.publicKey.toBase58(), second.publicKey.toBase58()], threshold: 2, executorSignerId: executor.id } });
    expect(prepared.statusCode).toBe(200);
    const creation = prepared.json().data as { multisigPda: string; vaultPda: string; transactionBase64: string };

    // The member's wallet signs and sends the (createKey-signed) creation transaction.
    const transaction = VersionedTransaction.deserialize(Buffer.from(creation.transactionBase64, "base64"));
    transaction.sign([owner]);
    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
    await airdrop(new PublicKey(creation.vaultPda), 3);
    const squads = new SquadsGovernanceAdapter(new SolanaAdapter({ rpcUrl: solanaRpc!, network: solNetwork, finality: "confirmed" }));
    expect((await squads.observe(creation.multisigPda)).members.find((member) => member.key === executor.address)).toMatchObject({ canVote: false, canExecute: true });

    expect((await app!.inject({ method: "POST", url: "/v1/treasuries", headers: bearer(token), payload: { name: "Wrong vault", chainFamily: "svm", network: solNetwork, address: owner.publicKey.toBase58(), governance: "squads", executorSignerId: executor.id, multisigPda: creation.multisigPda } })).statusCode).toBe(422);
    const registered = await app!.inject({ method: "POST", url: "/v1/treasuries", headers: bearer(token), payload: { name: "Vault", chainFamily: "svm", network: solNetwork, address: creation.vaultPda, governance: "squads", executorSignerId: executor.id, multisigPda: creation.multisigPda } });
    expect(registered.statusCode).toBe(201);
    const treasuryId = registered.json().data.id as string;

    const nativeAsset = `${solNetwork}/slip44:501`;
    const agent = (await app!.inject({ method: "POST", url: "/v1/agents", headers: bearer(token), payload: { displayName: "Payables", purpose: "Pay vendors" } })).json().data as { id: string };
    const agentToken = (await app!.inject({ method: "POST", url: `/v1/agents/${agent.id}/credentials`, headers: bearer(token), payload: {} })).json().token as string;
    const policy = (await app!.inject({ method: "POST", url: "/v1/policies", headers: bearer(token), payload: { name: "Vault policy", definition: { maxPerTransactionBaseUnits: String(2 * LAMPORTS_PER_SOL), maxDailyBaseUnits: String(4 * LAMPORTS_PER_SOL), allowedNetworks: [solNetwork], allowedAssets: [nativeAsset] } } })).json().data as { id: string };
    await app!.inject({ method: "POST", url: `/v1/policies/${policy.id}/bindings`, headers: bearer(token), payload: { agentId: agent.id } });
    const destination = Keypair.generate().publicKey.toBase58();
    const submitted = await app!.inject({ method: "POST", url: "/v1/agent/intents", headers: bearer(agentToken), payload: { idempotencyKey: `squads-${crypto.randomUUID()}`, treasuryAccountId: treasuryId, assetId: nativeAsset, amountBaseUnits: "1000000", destination, purpose: "Squads governed vendor payment" } });
    expect(submitted.statusCode).toBe(202);
    const intentId = submitted.json().data.id as string;
    const pending = await untilStatus(token, intentId, ["approval_required", "rejected", "failed"]);
    expect(pending.intent.status).toBe("approval_required");
    expect(pending.approval.externalRef.kind).toBe("squads");

    for (const [keypair, sessionToken] of [[owner, token], [second, secondSession.session.token]] as const) {
      const messageResponse = await app!.inject({ method: "GET", url: `/v1/intents/${intentId}/approval-message/approved`, headers: bearer(sessionToken) });
      expect(messageResponse.json().data.kind).toBe("solana_transaction");
      const vote = VersionedTransaction.deserialize(Buffer.from(messageResponse.json().data.transactionBase64 as string, "base64"));
      vote.sign([keypair]);
      const voteSignature = await connection.sendRawTransaction(vote.serialize());
      await connection.confirmTransaction({ signature: voteSignature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
      expect((await app!.inject({ method: "POST", url: `/v1/intents/${intentId}/approve`, headers: bearer(sessionToken), payload: { transactionSignature: voteSignature } })).statusCode).toBe(202);
    }
    const done = await untilStatus(token, intentId, ["reconciled", "failed"], 120);
    expect(done.intent.status).toBe("reconciled");
    expect(done.approval.approvals).toBe(2);
    expect(await connection.getBalance(new PublicKey(destination), "finalized")).toBe(1_000_000);
    void deployer;
  }, 240_000);
});
