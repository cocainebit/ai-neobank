import { existsSync, readFileSync } from "node:fs";
import type { SafeContractAddresses } from "@ai-neobank/safe-adapter";

/**
 * Local chains have no canonical Safe deployments, so scripts/localnet.sh records
 * the fixture addresses and the server reads them from there. Public networks need
 * nothing here: Protocol Kit already knows their deployments.
 */
export function readLocalSafeContracts(file: string | undefined): SafeContractAddresses | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { safe?: SafeContractAddresses };
    return parsed.safe?.safeSingletonAddress ? parsed.safe : undefined;
  } catch {
    return undefined;
  }
}
