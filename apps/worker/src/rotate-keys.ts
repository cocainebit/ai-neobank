/**
 * Re-wraps every software signer's data key under the active key-encryption key.
 *
 *   SIGNER_KEYRING="1:<old hex>,2:<new hex>" SIGNER_ACTIVE_KEY_VERSION=2 pnpm --filter @ai-neobank/worker rotate-keys
 *   KMS_DATA_KEY_ID=arn:aws:kms:... SIGNER_KEYRING="1:<old hex>" pnpm --filter @ai-neobank/worker rotate-keys
 *
 * Keep the old key available until this reports zero remaining, then retire it.
 */
import { createPostgresStore } from "@ai-neobank/database";
import { keyConfigurationFromEnv } from "@ai-neobank/signer";
import { rotateKeyEncryption } from "./worker.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const configuration = await keyConfigurationFromEnv(process.env);
if (!configuration.keys) throw new Error("Configure SIGNER_KEYRING or KMS_DATA_KEY_ID first");
const store = createPostgresStore(databaseUrl);
try {
  console.log(`Rotating to ${configuration.keys.activeVersion}: ${configuration.description}`);
  const result = await rotateKeyEncryption(store, configuration.keys, { onProgress: (done) => { if (done % 100 === 0) console.log(`  ${done} re-wrapped`); } });
  const remaining = await store.listSignersToRewrap(configuration.keys.activeVersion, { limit: 1 });
  console.log(`Re-wrapped ${result.rewrapped}; ${result.failed.length} could not be opened with the configured keys`);
  for (const failure of result.failed.slice(0, 20)) console.log(`  ${failure.signerId}: ${failure.reason}`);
  if (remaining.length > 0) {
    console.log("Some signers are still under an older key. Keep the old key configured until this reports none remaining.");
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
