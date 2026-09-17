/**
 * Local x402 counterparties for integration tests: a facilitator that verifies
 * and settles on the local chains, and an Express seller that returns 402s and
 * serves the resource once paid. Nothing here runs in production.
 */
import express from "express";
import type { Server } from "node:http";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { paymentMiddleware } from "@x402/express";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { registerExactEvmScheme as registerExmServer } from "@x402/evm/exact/server";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactSvmScheme as registerSvmFacilitator } from "@x402/svm/exact/facilitator";
import { registerExactSvmScheme as registerSvmServer } from "@x402/svm/exact/server";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface LocalFacilitatorOptions {
  evm?: { rpcUrl: string; chainId: number; privateKey: Hex };
  solana?: { rpcUrl: string; wireNetwork: string; secretKey: Uint8Array };
}

export interface LocalFacilitator {
  client: FacilitatorClient;
  evmAddress?: string;
  solanaAddress?: string;
}

/** An in-process facilitator exposed through the FacilitatorClient interface the resource server expects. */
export async function createLocalFacilitator(options: LocalFacilitatorOptions): Promise<LocalFacilitator> {
  const facilitator = new x402Facilitator();
  const result: LocalFacilitator = { client: { verify: (payload, requirements) => facilitator.verify(payload, requirements), settle: (payload, requirements) => facilitator.settle(payload, requirements), getSupported: async () => facilitator.getSupported() as unknown as SupportedResponse } };
  if (options.evm) {
    const chain = defineChain({ id: options.evm.chainId, name: `local-${options.evm.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [options.evm.rpcUrl] } } });
    const account = privateKeyToAccount(options.evm.privateKey);
    const wallet = createWalletClient({ account, chain, transport: http(options.evm.rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(options.evm.rpcUrl) });
    const signer = toFacilitatorEvmSigner({
      address: account.address as Hex,
      readContract: (args) => publicClient.readContract(args as never),
      verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
      writeContract: (args) => wallet.writeContract({ ...(args as object), account, chain } as never),
      sendTransaction: (args) => wallet.sendTransaction({ ...args, account, chain }),
      waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
      getCode: (args) => publicClient.getCode(args)
    });
    facilitator.register(`eip155:${options.evm.chainId}`, new ExactEvmFacilitatorScheme(signer));
    result.evmAddress = account.address;
  }
  if (options.solana) {
    const signer = await createKeyPairSignerFromBytes(options.solana.secretKey);
    registerSvmFacilitator(facilitator, { signer: toFacilitatorSvmSigner(signer, { defaultRpcUrl: options.solana.rpcUrl }), networks: [options.solana.wireNetwork as `${string}:${string}`] });
    result.solanaAddress = signer.address;
  }
  return result;
}

export interface SellerRoute {
  /** Express-style route key such as "GET /report". */
  route: string;
  network: string;
  payTo: string;
  /** Token address (EVM) or mint (Solana). */
  asset: string;
  amount: string;
  /** EVM: the token's EIP-712 name and version. */
  extra?: Record<string, unknown>;
  description?: string;
  body: unknown;
}

export interface LocalSeller {
  url: string;
  close(): Promise<void>;
}

/** A seller that prices routes in the local test token and serves JSON once the facilitator settles. */
export async function startLocalSeller(facilitator: FacilitatorClient, routes: SellerRoute[], options: { evm?: { rpcUrl: string }; solana?: { rpcUrl: string; wireNetwork: string } } = {}): Promise<LocalSeller> {
  const server = new x402ResourceServer(facilitator);
  if (options.evm) registerExmServer(server);
  if (options.solana) registerSvmServer(server, { networks: [options.solana.wireNetwork as `${string}:${string}`] } as never);
  const app = express();
  const config = Object.fromEntries(routes.map((route) => [route.route, {
    accepts: { scheme: "exact", network: route.network as `${string}:${string}`, payTo: route.payTo, price: { asset: route.asset, amount: route.amount, ...(route.extra ? { extra: route.extra } : {}) } },
    description: route.description ?? "Relay test resource",
    mimeType: "application/json"
  }]));
  app.use(paymentMiddleware(config, server));
  for (const route of routes) {
    const [method, path] = route.route.split(" ");
    (app as unknown as Record<string, (path: string, handler: express.RequestHandler) => void>)[(method ?? "GET").toLowerCase()]!(path ?? "/", (_request, response) => { response.json(route.body); });
  }
  const listener = await new Promise<Server>((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve()))) };
}
