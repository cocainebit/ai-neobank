import { ChainedKeyProvider, KmsKeyProvider, LocalKeyring, awsKmsClient, parseKeyring, type KeyEncryptionProvider, type KmsClient } from "./kms.js";

export interface KeyConfiguration {
  /** Seals and opens software signers' data keys. Absent when nothing is configured. */
  keys?: KeyEncryptionProvider;
  /** Signs for signers whose private key lives in KMS. */
  kms?: KmsClient;
  /** A human-readable summary for logs; never contains key material. */
  description: string;
}

/**
 * Reads key configuration from the environment:
 * - SIGNER_KEYRING="v1:hex,v2:hex" with SIGNER_ACTIVE_KEY_VERSION, or SIGNER_MASTER_KEY (legacy, version "1")
 * - KMS_DATA_KEY_ID: wrap data keys with this AWS KMS key; the local keyring stays available to unwrap older envelopes
 * - KMS_SIGNING=true: enable signers held in AWS KMS (region from AWS_REGION)
 */
export async function keyConfigurationFromEnv(env: Record<string, string | undefined>): Promise<KeyConfiguration> {
  let keyring: LocalKeyring | undefined;
  if (env.SIGNER_KEYRING) keyring = parseKeyring(env.SIGNER_KEYRING, env.SIGNER_ACTIVE_KEY_VERSION);
  else if (env.SIGNER_MASTER_KEY) keyring = parseKeyring(env.SIGNER_MASTER_KEY, "1");
  let kms: KmsClient | undefined;
  if (env.KMS_DATA_KEY_ID || env.KMS_SIGNING === "true") {
    const sdk = await import("@aws-sdk/client-kms");
    const client = new sdk.KMSClient(env.AWS_REGION ? { region: env.AWS_REGION } : {});
    kms = awsKmsClient(client as unknown as { send(command: unknown): Promise<unknown> }, {
      EncryptCommand: sdk.EncryptCommand as unknown as new (input: unknown) => unknown,
      DecryptCommand: sdk.DecryptCommand as unknown as new (input: unknown) => unknown,
      GetPublicKeyCommand: sdk.GetPublicKeyCommand as unknown as new (input: unknown) => unknown,
      SignCommand: sdk.SignCommand as unknown as new (input: unknown) => unknown
    });
  }
  const parts: string[] = [];
  let keys: KeyEncryptionProvider | undefined = keyring;
  if (env.KMS_DATA_KEY_ID && kms) {
    keys = new ChainedKeyProvider(new KmsKeyProvider(kms, env.KMS_DATA_KEY_ID), keyring ? [keyring] : []);
    parts.push(`data keys wrapped by KMS key ${env.KMS_DATA_KEY_ID}${keyring ? " (local keyring kept for older envelopes)" : ""}`);
  } else if (keyring) {
    parts.push(`data keys wrapped by local keyring version ${keyring.activeVersion}`);
  }
  if (env.KMS_SIGNING === "true") parts.push("KMS-held EVM signers enabled");
  return { ...(keys ? { keys } : {}), ...(env.KMS_SIGNING === "true" && kms ? { kms } : {}), description: parts.join("; ") || "no signer keys configured" };
}
