import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createPostgresJobQueue, createPostgresStore } from "@ai-neobank/database";
import { KmsKeyProvider, LocalKeyring, awsKmsClient, evmAddressFromSpki } from "@ai-neobank/signer";
import { SoftKms, softKmsCommands } from "@ai-neobank/signer/testing";
import { buildApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_API_INTEGRATION === "1" && databaseUrl;
const testIf = enabled ? it : it.skip;
const domain = "relay.test";
const uri = "http://relay.test";
const softKms = new SoftKms();
const kms = awsKmsClient(softKms, softKmsCommands);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function app(environment: "development" | "production", keys: LocalKeyring | KmsKeyProvider) {
  return buildApp({ store: createPostgresStore(databaseUrl!), queue: createPostgresJobQueue(databaseUrl!), environment, auth: { domain, uri, secureCookies: false }, webOrigin: uri, keys, kms, allowSoftwareSigners: true, logger: false });
}

const production = enabled ? app("production", new LocalKeyring({ p1: new Uint8Array(32).fill(81) }, "p1")) : null;
const productionKms = enabled ? app("production", new KmsKeyProvider(kms, softKms.createSymmetricKey())) : null;

beforeAll(async () => { await production?.ready(); await productionKms?.ready(); });
afterAll(async () => { await production?.close(); await productionKms?.close(); });

async function signIn(server: NonNullable<typeof production>, account: PrivateKeyAccount) {
  const challenge = await server.inject({ method: "POST", url: "/v1/auth/challenges", payload: { chainFamily: "evm", address: account.address, chainReference: "1" } });
  const { nonce, message } = challenge.json().data as { nonce: string; message: string };
  const verify = await server.inject({ method: "POST", url: "/v1/auth/verify", payload: { chainFamily: "evm", address: account.address, nonce, signature: await account.signMessage({ message }) } });
  expect(verify.statusCode).toBe(200);
  return verify.json().data.session.token as string;
}

describe("signer custody over HTTP", () => {
  testIf("production refuses locally wrapped software signers, accepts KMS-wrapped ones, and registers KMS-held keys by public key", async () => {
    const localToken = await signIn(production!, privateKeyToAccount(generatePrivateKey()));
    const refused = await production!.inject({ method: "POST", url: "/v1/signers", headers: bearer(localToken), payload: { chainFamily: "evm" } });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error).toBe("software_signers_need_kms");
    expect((await production!.inject({ method: "GET", url: "/health" })).json().integrations.softwareSigners).toBe("enabled_local_keyring");

    const token = await signIn(productionKms!, privateKeyToAccount(generatePrivateKey()));
    expect((await productionKms!.inject({ method: "GET", url: "/health" })).json().integrations).toMatchObject({ softwareSigners: "enabled_kms_wrapped", kmsSigners: "enabled" });
    const sealed = await productionKms!.inject({ method: "POST", url: "/v1/signers", headers: bearer(token), payload: { chainFamily: "svm" } });
    expect(sealed.statusCode).toBe(201);
    expect((await productionKms!.inject({ method: "POST", url: "/v1/signers", headers: bearer(token), payload: { chainFamily: "evm", revealDevelopmentSecret: true } })).statusCode).toBe(403);

    const keyId = softKms.createSigningKey();
    const registered = await productionKms!.inject({ method: "POST", url: "/v1/signers/kms", headers: bearer(token), payload: { chainFamily: "evm", kmsKeyId: keyId } });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().data).toMatchObject({ custody: "kms", address: evmAddressFromSpki(await kms.getPublicKey(keyId)) });
    const missing = await productionKms!.inject({ method: "POST", url: "/v1/signers/kms", headers: bearer(token), payload: { chainFamily: "evm", kmsKeyId: "arn:aws:kms:local:000000000000:key/missing" } });
    expect(missing.statusCode).toBe(422);

    // Rotation is for governed treasuries only.
    const treasury = await productionKms!.inject({ method: "POST", url: "/v1/treasuries", headers: bearer(token), payload: { name: "Direct", chainFamily: "evm", network: "eip155:31337", address: registered.json().data.address, governance: "direct" } });
    expect(treasury.statusCode).toBe(201);
    const rotation = await productionKms!.inject({ method: "POST", url: `/v1/treasuries/${treasury.json().data.id}/executor-rotations`, headers: bearer(token), payload: { signerId: registered.json().data.id } });
    expect(rotation.statusCode).toBe(409);
    expect(rotation.json().error).toBe("treasury_not_governed");
  });
});
