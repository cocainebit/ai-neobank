/** Exact decimal string from base units, trimmed of trailing zeros. */
export function formatUnits(value: string | bigint, decimals: number): string {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Display amount: grouped thousands, a fixed number of decimals, rounded toward zero so nothing is overstated. */
export function displayUnits(value: string | bigint, decimals: number, places = displayPlaces(decimals)): string {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const scale = 10n ** BigInt(Math.max(decimals - places, 0));
  const truncated = decimals > places ? absolute / scale : absolute * 10n ** BigInt(places - decimals);
  const digits = truncated.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = places > 0 ? digits.slice(digits.length - places) : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function displayPlaces(decimals: number): number {
  if (decimals <= 2) return decimals;
  if (decimals <= 8) return 2;
  return 4;
}

/** Parses a decimal string into base units, refusing more precision than the asset has. */
export function parseUnits(input: string, decimals: number): bigint {
  const value = input.trim().replaceAll(",", "");
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("Enter a number");
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function shortAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

const networkNames: Record<string, string> = {
  "eip155:1": "Ethereum",
  "eip155:8453": "Base",
  "eip155:84532": "Base Sepolia",
  "eip155:11155111": "Sepolia",
  "eip155:31337": "Local EVM",
  "solana:mainnet": "Solana",
  "solana:devnet": "Solana Devnet",
  "solana:localnet": "Local Solana"
};

export function networkLabel(network: string): string {
  return networkNames[network] ?? network;
}

export function isSolana(network: string): boolean {
  return network.startsWith("solana:");
}

export function explorerUrl(network: string, hash: string): string | null {
  if (network === "eip155:8453") return `https://basescan.org/tx/${hash}`;
  if (network === "eip155:84532") return `https://sepolia.basescan.org/tx/${hash}`;
  if (network === "solana:devnet") return `https://explorer.solana.com/tx/${hash}?cluster=devnet`;
  if (network === "solana:mainnet") return `https://explorer.solana.com/tx/${hash}`;
  return null;
}

/** Relative time; call only on the client (it reads the clock). */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Not set";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export type Tone = "positive" | "pending" | "negative" | "info" | "neutral";

const intentTones: Record<string, Tone> = {
  received: "info", policy_evaluated: "info", approval_required: "pending", approved: "info", auto_authorized: "info",
  executing: "info", submitted: "info", finalized: "positive", reconciled: "positive", rejected: "negative", failed: "negative", expired: "neutral"
};

const intentLabels: Record<string, string> = {
  received: "Checking", policy_evaluated: "Publishing", approval_required: "Needs approval", approved: "Approved", auto_authorized: "Authorized",
  executing: "Signing", submitted: "Submitted", finalized: "Settled", reconciled: "Settled", rejected: "Rejected", failed: "Failed", expired: "Expired"
};

export function intentStatus(status: string): { tone: Tone; label: string } {
  return { tone: intentTones[status] ?? "neutral", label: intentLabels[status] ?? status.replaceAll("_", " ") };
}

export function sentence(value: string): string {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
