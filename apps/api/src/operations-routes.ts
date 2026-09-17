import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OperationsError, OperationsStore, type PostgresControlPlaneStore, type PostgresJobQueue, type StatementRecord } from "@ai-neobank/database";
import type { PrincipalRole } from "@ai-neobank/domain";
import { canonicalAddress, verifyWalletSignature } from "@ai-neobank/auth";
import type { EvmAdapter } from "@ai-neobank/evm-adapter";
import type { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { z } from "zod";

interface HumanContext { organizationId: string; principalId: string; walletId: string | null; role: PrincipalRole }

export interface OperationsRouteContext {
  options: { environment: string; auth: { domain: string }; x402Seller?: { facilitator: FacilitatorClient }; chains?: { evm?: { chainId: number } } };
  store: PostgresControlPlaneStore;
  operations: OperationsStore;
  queue: PostgresJobQueue | undefined;
  human(request: FastifyRequest, reply: FastifyReply, roles?: PrincipalRole[]): HumanContext | null;
  adapters: { evm: EvmAdapter | null; solana: SolanaAdapter | null };
  /** CAIP-2 id used on the x402 wire for a Relay network. */
  wireNetwork(family: "evm" | "svm", network: string): Promise<string>;
}

const uuid = z.string().uuid();
const network = z.string().regex(/^[a-z0-9]+:[a-zA-Z0-9-]+$/);
const baseUnits = z.string().regex(/^\d+$/);

const beneficiarySchema = z.object({ name: z.string().min(1).max(120), chainFamily: z.enum(["evm", "svm"]), network, address: z.string().min(20), email: z.string().email().optional(), notes: z.string().max(500).optional() });
const signatureSchema = z.object({ signature: z.string().min(16).max(8192) });
const scheduleSchema = z.object({
  treasuryAccountId: uuid, beneficiaryId: uuid, assetId: z.string().min(1), amountBaseUnits: baseUnits, purpose: z.string().min(3).max(200),
  intervalUnit: z.enum(["day", "week", "month"]), intervalCount: z.number().int().min(1).max(365).default(1),
  startAt: z.string().datetime(), endAt: z.string().datetime().optional(), maxOccurrences: z.number().int().positive().optional()
});
const scheduleStatusSchema = z.object({ status: z.enum(["active", "paused", "cancelled"]) });
const invoiceSchema = z.object({
  treasuryAccountId: uuid, assetId: z.string().min(1), customerName: z.string().min(1).max(120), customerEmail: z.string().email().optional(), memo: z.string().max(1000).optional(),
  lineItems: z.array(z.object({ description: z.string().min(1).max(200), quantity: z.number().int().min(1).max(1_000_000), unitAmountBaseUnits: baseUnits })).min(1).max(100),
  dueAt: z.string().datetime().optional(), issue: z.boolean().default(true)
});
const allocationSchema = z.object({ invoiceId: uuid });
const statementQuery = z.object({ treasuryAccountId: uuid, assetId: z.string().min(1), from: z.string().datetime().optional(), to: z.string().datetime().optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional(), format: z.enum(["json", "csv"]).default("json") });

function invalid(reply: FastifyReply, details: unknown) {
  return reply.code(400).send({ error: "invalid_request", details });
}

function operationsFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof OperationsError) {
    const status = error.code.endsWith("not_found") ? 404 : 409;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  if (error instanceof Error && /duplicate key value/.test(error.message)) return reply.code(409).send({ error: "already_exists" });
  throw error;
}

/** Decimal rendering of base units; exact, never through floating point. */
export function formatUnits(value: string | bigint, decimals: number): string {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function statementCsv(statement: StatementRecord): string {
  const quote = (value: string) => /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const rows = [["date", "category", "description", "amount", "balance", "reference", "intent"]];
  rows.push([statement.from, "opening_balance", "Opening balance", "", formatUnits(statement.openingBalanceBaseUnits, statement.decimals), "", ""]);
  for (const line of statement.lines) rows.push([line.effectiveAt, line.category, line.description, formatUnits(line.amountBaseUnits, statement.decimals), formatUnits(line.runningBalanceBaseUnits, statement.decimals), line.reference ?? "", line.intentId ?? ""]);
  rows.push([statement.to, "closing_balance", "Closing balance", "", formatUnits(statement.closingBalanceBaseUnits, statement.decimals), "", ""]);
  return rows.map((row) => row.map(quote).join(",")).join("\n") + "\n";
}

export function registerOperationsRoutes(app: FastifyInstance, context: OperationsRouteContext): void {
  const { store, operations, human, options } = context;

  // Beneficiaries

  app.get("/v1/beneficiaries", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    return { data: await operations.listBeneficiaries(auth.organizationId) };
  });

  app.post("/v1/beneficiaries", async (request, reply) => {
    const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
    const body = beneficiarySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    if ((body.data.chainFamily === "evm") !== body.data.network.startsWith("eip155:")) return invalid(reply, "Network does not match the chain family");
    let address: string;
    try { address = canonicalAddress(body.data.chainFamily, body.data.address); } catch { return invalid(reply, "Invalid address"); }
    try {
      const { email, notes, ...rest } = body.data;
      return reply.code(201).send({ data: await operations.createBeneficiary(auth.organizationId, { ...rest, address, ...(email ? { email } : {}), ...(notes ? { notes } : {}) }, auth.principalId) });
    } catch (error) { return operationsFailure(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/v1/beneficiaries/:id/approval-message", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid beneficiary ID");
    const beneficiary = await operations.getBeneficiary(auth.organizationId, id.data);
    if (!beneficiary) return reply.code(404).send({ error: "beneficiary_not_found" });
    return { data: { message: OperationsStore.beneficiaryApprovalMessage(options.auth.domain, beneficiary) } };
  });

  /** Step-up: a new recipient becomes payable only with an owner's wallet signature over its exact address. */
  app.post<{ Params: { id: string } }>("/v1/beneficiaries/:id/approve", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const body = signatureSchema.safeParse(request.body);
    if (!id.success || !body.success) return invalid(reply, "Invalid beneficiary ID or signature");
    const beneficiary = await operations.getBeneficiary(auth.organizationId, id.data);
    if (!beneficiary) return reply.code(404).send({ error: "beneficiary_not_found" });
    const wallet = (await store.listMembers(auth.organizationId)).find((member) => member.id === auth.principalId)?.wallets.find((candidate) => candidate.id === auth.walletId);
    if (!wallet) return reply.code(403).send({ error: "no_wallet_bound" });
    const message = OperationsStore.beneficiaryApprovalMessage(options.auth.domain, beneficiary);
    if (!(await verifyWalletSignature({ chainFamily: wallet.chainFamily, address: wallet.address, message, signature: body.data.signature }))) return reply.code(401).send({ error: "approval_signature_invalid" });
    try {
      return { data: await operations.approveBeneficiary(auth.organizationId, id.data, auth.principalId, JSON.stringify({ address: wallet.address, signature: body.data.signature })) };
    } catch (error) { return operationsFailure(reply, error); }
  });

  app.post<{ Params: { id: string } }>("/v1/beneficiaries/:id/archive", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid beneficiary ID");
    try { return { data: await operations.archiveBeneficiary(auth.organizationId, id.data, auth.principalId) }; } catch (error) { return operationsFailure(reply, error); }
  });

  // Recurring payments

  app.get("/v1/schedules", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    return { data: await operations.listSchedules(auth.organizationId) };
  });

  app.post("/v1/schedules", async (request, reply) => {
    const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
    const body = scheduleSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    try {
      return reply.code(201).send({ data: await operations.createSchedule(auth.organizationId, { ...body.data, ...(body.data.endAt ? { endAt: body.data.endAt } : {}), ...(body.data.maxOccurrences ? { maxOccurrences: body.data.maxOccurrences } : {}) } as Parameters<OperationsStore["createSchedule"]>[1], auth.principalId) });
    } catch (error) { return operationsFailure(reply, error); }
  });

  app.patch<{ Params: { id: string } }>("/v1/schedules/:id", async (request, reply) => {
    const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const body = scheduleStatusSchema.safeParse(request.body);
    if (!id.success || !body.success) return invalid(reply, "Invalid schedule ID or status");
    try { return { data: await operations.setScheduleStatus(auth.organizationId, id.data, body.data.status, auth.principalId) }; } catch (error) { return operationsFailure(reply, error); }
  });

  // Invoices and receipts

  app.get("/v1/invoices", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    return { data: await operations.listInvoices(auth.organizationId) };
  });

  app.post("/v1/invoices", async (request, reply) => {
    const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
    const body = invoiceSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    try {
      const { customerEmail, memo, dueAt, ...rest } = body.data;
      return reply.code(201).send({ data: await operations.createInvoice(auth.organizationId, { ...rest, ...(customerEmail ? { customerEmail } : {}), ...(memo ? { memo } : {}), ...(dueAt ? { dueAt } : {}) }, auth.principalId) });
    } catch (error) { return operationsFailure(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/v1/invoices/:id", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid invoice ID");
    const detail = await operations.getInvoice(auth.organizationId, id.data);
    if (!detail) return reply.code(404).send({ error: "invoice_not_found" });
    return { data: detail };
  });

  for (const action of ["issue", "void"] as const) {
    app.post<{ Params: { id: string } }>(`/v1/invoices/:id/${action}`, async (request, reply) => {
      const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
      const id = uuid.safeParse(request.params.id);
      if (!id.success) return invalid(reply, "Invalid invoice ID");
      try {
        return { data: action === "issue" ? await operations.issueInvoice(auth.organizationId, id.data, auth.principalId) : await operations.voidInvoice(auth.organizationId, id.data, auth.principalId) };
      } catch (error) { return operationsFailure(reply, error); }
    });
  }

  app.get("/v1/inflows", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const query = z.object({ treasuryAccountId: uuid.optional(), unallocated: z.enum(["true", "false"]).optional() }).safeParse(request.query);
    if (!query.success) return invalid(reply, query.error.flatten());
    return { data: await operations.listInflows(auth.organizationId, { ...(query.data.treasuryAccountId ? { treasuryAccountId: query.data.treasuryAccountId } : {}), unallocatedOnly: query.data.unallocated === "true" }) };
  });

  app.post<{ Params: { id: string } }>("/v1/inflows/:id/allocate", async (request, reply) => {
    const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const body = allocationSchema.safeParse(request.body);
    if (!id.success || !body.success) return invalid(reply, "Invalid receipt or invoice ID");
    try { return { data: await operations.allocateInflow(auth.organizationId, id.data, body.data.invoiceId, auth.principalId) }; } catch (error) { return operationsFailure(reply, error); }
  });

  // Reconciliation and statements

  app.get("/v1/reconciliation", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    return { data: await operations.latestReconciliations(auth.organizationId) };
  });

  app.post<{ Params: { id: string } }>("/v1/treasuries/:id/sync", async (request, reply) => {
    const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid treasury ID");
    if (!context.queue) return reply.code(503).send({ error: "queue_not_configured" });
    if (!(await store.getTreasury(auth.organizationId, id.data))) return reply.code(404).send({ error: "treasury_not_found" });
    await context.queue.enqueueJob(auth.organizationId, "treasury.sync", { treasuryId: id.data }, `sync:${id.data}:manual:${Math.floor(Date.now() / 10_000)}`);
    return reply.code(202).send({ data: { treasuryId: id.data, queued: true } });
  });

  app.get("/v1/statements", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const query = statementQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error.flatten());
    let from = query.data.from;
    let to = query.data.to;
    if (query.data.month) {
      const [year, month] = query.data.month.split("-").map(Number) as [number, number];
      from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
      to = new Date(Date.UTC(year, month, 1)).toISOString();
    }
    if (!from || !to) return invalid(reply, "Provide month, or from and to");
    const statement = await operations.statement(auth.organizationId, { treasuryAccountId: query.data.treasuryAccountId, assetId: query.data.assetId, from, to });
    if (!statement) return reply.code(404).send({ error: "statement_not_found" });
    if (query.data.format === "csv") {
      return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="statement-${statement.symbol}-${from.slice(0, 10)}.csv"`).send(statementCsv(statement));
    }
    return { data: statement };
  });

  // Public invoice pages: no session; the unguessable token is the capability.

  async function publicInvoice(token: string) {
    const invoice = await operations.getInvoiceByToken(token);
    if (!invoice || invoice.status === "draft") return null;
    return invoice;
  }

  app.get<{ Params: { token: string } }>("/v1/public/invoices/:token", async (request, reply) => {
    const invoice = await publicInvoice(request.params.token);
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const remaining = BigInt(invoice.amountDueBaseUnits) - BigInt(invoice.amountPaidBaseUnits);
    const payable = invoice.status === "open" && remaining > 0n;
    const amount = formatUnits(invoice.amountDueBaseUnits, invoice.decimals);
    const instructions: Record<string, string> = {};
    if (payable && invoice.chainFamily === "svm") {
      const params = new URLSearchParams({ amount, reference: invoice.reference ?? "", label: invoice.organizationName, message: `Invoice ${invoice.number}` });
      if (invoice.assetKind === "spl" && invoice.assetAddress) params.set("spl-token", invoice.assetAddress);
      instructions.solanaPay = `solana:${invoice.treasuryAddress}?${params.toString()}`;
    }
    if (payable && invoice.chainFamily === "evm" && invoice.assetAddress) {
      instructions.eip681 = `ethereum:${invoice.assetAddress}@${invoice.network.split(":")[1]}/transfer?address=${invoice.treasuryAddress}&uint256=${invoice.amountDueBaseUnits}`;
    }
    if (payable && options.x402Seller) instructions.x402 = `${request.protocol}://${request.headers.host}/v1/public/invoices/${request.params.token}/x402`;
    return {
      data: {
        number: invoice.number, status: invoice.status, issuer: invoice.organizationName, customerName: invoice.customerName, memo: invoice.memo,
        lineItems: invoice.lineItems, currency: invoice.symbol, decimals: invoice.decimals, network: invoice.network,
        subtotal: formatUnits(invoice.subtotalBaseUnits, invoice.decimals), amountDue: amount, amountPaid: formatUnits(invoice.amountPaidBaseUnits, invoice.decimals),
        amountDueBaseUnits: invoice.amountDueBaseUnits, payTo: invoice.treasuryAddress, asset: invoice.assetAddress, dueAt: invoice.dueAt, paidAt: invoice.paidAt,
        amountNote: invoice.amountDueBaseUnits !== invoice.subtotalBaseUnits ? "The amount due includes a sub-cent identifier so your payment is matched automatically. Pay the exact amount." : null,
        instructions
      }
    };
  });

  let seller: x402ResourceServer | null = null;
  async function x402Server(): Promise<x402ResourceServer> {
    if (seller) return seller;
    if (!options.x402Seller) throw new Error("x402 seller is not configured");
    const server = new x402ResourceServer(options.x402Seller.facilitator);
    registerExactEvmScheme(server);
    registerExactSvmScheme(server, {} as never);
    await server.initialize();
    seller = server;
    return server;
  }

  /** x402 v2: 402 with the invoice's terms, then verify and settle through the facilitator and apply the receipt. */
  app.get<{ Params: { token: string } }>("/v1/public/invoices/:token/x402", async (request, reply) => {
    if (!options.x402Seller) return reply.code(404).send({ error: "x402_not_enabled" });
    const invoice = await publicInvoice(request.params.token);
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const remaining = BigInt(invoice.subtotalBaseUnits) - BigInt(invoice.amountPaidBaseUnits);
    if (invoice.status !== "open" || remaining <= 0n) return reply.code(409).send({ error: "invoice_not_payable", status: invoice.status });
    if (invoice.assetKind === "native" || !invoice.assetAddress) return reply.code(409).send({ error: "invoice_asset_not_x402_payable" });
    const server = await x402Server();
    let extra: Record<string, unknown> | undefined;
    if (invoice.chainFamily === "evm") {
      if (!context.adapters.evm) return reply.code(503).send({ error: "network_not_configured" });
      extra = await context.adapters.evm.readEip712Domain(invoice.assetAddress);
    }
    const wire = await context.wireNetwork(invoice.chainFamily, invoice.network);
    const requirements = await server.buildPaymentRequirements({ scheme: "exact", payTo: invoice.treasuryAddress, network: wire as `${string}:${string}`, price: { asset: invoice.assetAddress, amount: remaining.toString(), ...(extra ? { extra } : {}) }, maxTimeoutSeconds: 300 });
    const resource = { url: `${request.protocol}://${request.headers.host}${request.url.split("?")[0]}`, description: `Invoice ${invoice.number} from ${invoice.organizationName}`, mimeType: "application/json" };
    const refuse = async (error?: string) => {
      const required = await server.createPaymentRequiredResponse(requirements, resource, error);
      return reply.code(402).header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(required)).send({ error: error ?? "payment_required", invoice: invoice.number });
    };
    const header = request.headers["payment-signature"];
    if (typeof header !== "string") return refuse();
    let payload;
    try { payload = decodePaymentSignatureHeader(header); } catch { return refuse("invalid_payment_header"); }
    const match = server.findMatchingRequirements(requirements, payload);
    if (!match) return refuse("payment_does_not_match_invoice");
    const verified = await server.verifyPayment(payload, match);
    if (!verified.isValid) return refuse(verified.invalidReason ?? "payment_invalid");
    const settled = await server.settlePayment(payload, match);
    if (!settled.success || !settled.transaction) return refuse(settled.errorReason ?? "settlement_failed");
    const recorded = await operations.recordInflow({ organizationId: invoice.organizationId, treasuryAccountId: invoice.treasuryAccountId, network: invoice.network, assetId: invoice.assetId, transactionHash: settled.transaction, eventKey: "x402", amountBaseUnits: match.amount, fromAddress: settled.payer ?? null, invoiceId: invoice.id, method: "x402" });
    const refreshed = recorded.invoice ?? (await operations.getInvoice(invoice.organizationId, invoice.id))?.invoice ?? null;
    return reply.code(200).header("PAYMENT-RESPONSE", encodePaymentResponseHeader(settled)).send({ data: { invoice: invoice.number, status: refreshed?.status ?? invoice.status, transaction: settled.transaction, amount: formatUnits(match.amount, invoice.decimals), currency: invoice.symbol } });
  });
}
