import type { JSONValue, Sql } from "postgres";
import { OperationsError } from "./operations.js";

export interface ExecutorRotationRecord {
  id: string;
  organizationId: string;
  treasuryAccountId: string;
  fromSignerId: string;
  toSignerId: string;
  status: "publishing" | "approval_required" | "executing" | "completed" | "rejected" | "failed";
  externalRef: Record<string, unknown> | null;
  publication: Record<string, unknown> | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RotationContext extends ExecutorRotationRecord {
  governance: "safe" | "squads" | "direct";
  network: string;
  chainFamily: "evm" | "svm";
  treasuryConfiguration: Record<string, unknown>;
  fromAddress: string;
  toAddress: string;
  fromKey: {
    custody: "encrypted_software" | "kms";
    encryptedSecret: string | null;
    encryptionNonce: string | null;
    authTag: string | null;
    keyVersion: number | null;
    dataKey: string | null;
    dataKeyVersion: string | null;
    kmsKeyId: string | null;
  };
}

const rotationColumns = `r.id::text, r.organization_id::text as "organizationId", r.treasury_account_id::text as "treasuryAccountId", r.from_signer_id::text as "fromSignerId",
  r.to_signer_id::text as "toSignerId", r.status, r.external_ref as "externalRef", r.publication, r.failure_reason as "failureReason", to_char(r.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt", to_char(r.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt"`;

/** Intent states in which a treasury has proposals or transactions that a rotation would strand. */
const inFlightStatuses = ["policy_evaluated", "approval_required", "approved", "executing", "submitted"];

export class RotationStore {
  constructor(readonly sql: Sql) {}

  /**
   * Starts replacing a governed treasury's executor. Safe completes at once:
   * the executor is not an owner, so nothing changes on chain. Squads needs a
   * config transaction the members approve; it is queued for publication.
   * Refused while intents are in flight, because a Squads config change makes
   * earlier proposals stale and a Safe executor swap would orphan a signed
   * execution.
   */
  async start(organizationId: string, treasuryId: string, toSignerId: string, actorPrincipalId: string): Promise<ExecutorRotationRecord> {
    return this.sql.begin(async (tx) => {
      const treasuries = await tx<{ governance: string; chainFamily: string; executorSignerId: string | null }[]>`
        select governance, chain_family as "chainFamily", executor_signer_id::text as "executorSignerId" from treasury_accounts
        where organization_id = ${organizationId} and id = ${treasuryId} for update
      `;
      const treasury = treasuries[0];
      if (!treasury) throw new OperationsError("treasury_not_found", "Treasury not found");
      if (treasury.governance === "direct" || !treasury.executorSignerId) throw new OperationsError("treasury_not_governed", "Only Safe and Squads treasuries have an executor");
      if (treasury.executorSignerId === toSignerId) throw new OperationsError("same_executor", "That signer is already the executor");
      const signers = await tx<{ status: string; chainFamily: string }[]>`select status, chain_family as "chainFamily" from signers where organization_id = ${organizationId} and id = ${toSignerId}`;
      if (!signers[0]) throw new OperationsError("signer_not_found", "Signer not found");
      if (signers[0].status !== "active" || signers[0].chainFamily !== treasury.chainFamily) throw new OperationsError("signer_not_usable", "The new executor must be an active signer on the treasury's chain");
      const busy = await tx<{ count: number }[]>`select count(*)::int as count from intents where treasury_account_id = ${treasuryId} and status = any(${inFlightStatuses})`;
      if ((busy[0]?.count ?? 0) > 0) throw new OperationsError("treasury_busy", `${busy[0]!.count} payments are in flight; finish or cancel them before rotating the executor`);
      const open = await tx`select 1 from executor_rotations where treasury_account_id = ${treasuryId} and status in ('publishing', 'approval_required', 'executing')`;
      if (open.count > 0) throw new OperationsError("rotation_in_progress", "A rotation is already in progress for this treasury");
      const status = treasury.governance === "safe" ? "completed" : "publishing";
      const rows = await tx<ExecutorRotationRecord[]>`
        insert into executor_rotations (organization_id, treasury_account_id, from_signer_id, to_signer_id, status, created_by)
        values (${organizationId}, ${treasuryId}, ${treasury.executorSignerId}, ${toSignerId}, ${status}, ${actorPrincipalId})
        returning id::text, organization_id::text as "organizationId", treasury_account_id::text as "treasuryAccountId", from_signer_id::text as "fromSignerId",
          to_signer_id::text as "toSignerId", status, external_ref as "externalRef", publication, failure_reason as "failureReason", to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt", to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt"
      `;
      const rotation = rows[0]!;
      if (status === "completed") {
        await tx`update treasury_accounts set executor_signer_id = ${toSignerId}, updated_at = now() where id = ${treasuryId}`;
      } else {
        await tx`insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload) values (${organizationId}, 'rotation.publish', 'executor_rotation', ${rotation.id}, ${tx.json({ rotationId: rotation.id })})`;
      }
      await tx`
        insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
        values (${organizationId}, ${actorPrincipalId}, ${status === "completed" ? "executor.rotated" : "executor.rotation_started"}, 'treasury', ${treasuryId},
          encode(digest(${`${treasury.executorSignerId}>${toSignerId}`}, 'sha256'), 'hex'), ${tx.json({ rotationId: rotation.id, from: treasury.executorSignerId, to: toSignerId })})
      `;
      return rotation;
    });
  }

  list(organizationId: string, treasuryId?: string): Promise<ExecutorRotationRecord[]> {
    return this.sql.unsafe<ExecutorRotationRecord[]>(`select ${rotationColumns} from executor_rotations r where r.organization_id = $1 and ($2::uuid is null or r.treasury_account_id = $2) order by r.created_at desc`, [organizationId, treasuryId ?? null]);
  }

  async get(organizationId: string, rotationId: string): Promise<ExecutorRotationRecord | null> {
    const rows = await this.sql.unsafe<ExecutorRotationRecord[]>(`select ${rotationColumns} from executor_rotations r where r.organization_id = $1 and r.id = $2`, [organizationId, rotationId]);
    return rows[0] ?? null;
  }

  async context(rotationId: string): Promise<RotationContext> {
    const rows = await this.sql.unsafe<(RotationContext & { fromCustody: string; encryptedSecret: string | null; encryptionNonce: string | null; authTag: string | null; keyVersion: number | null; dataKey: string | null; dataKeyVersion: string | null; kmsKeyId: string | null })[]>(
      `select ${rotationColumns}, t.governance, t.network, t.chain_family as "chainFamily", t.observed_configuration as "treasuryConfiguration",
         fs.address as "fromAddress", ts.address as "toAddress", fs.custody as "fromCustody", fs.encrypted_secret as "encryptedSecret", fs.encryption_nonce as "encryptionNonce",
         fs.auth_tag as "authTag", fs.key_version as "keyVersion", fs.data_key as "dataKey", fs.data_key_version as "dataKeyVersion", fs.kms_key_id as "kmsKeyId"
       from executor_rotations r join treasury_accounts t on t.id = r.treasury_account_id join signers fs on fs.id = r.from_signer_id join signers ts on ts.id = r.to_signer_id
       where r.id = $1`,
      [rotationId]
    );
    const row = rows[0];
    if (!row) throw new Error("Rotation not found");
    const { fromCustody, encryptedSecret, encryptionNonce, authTag, keyVersion, dataKey, dataKeyVersion, kmsKeyId, ...rest } = row;
    return { ...rest, fromKey: { custody: fromCustody as "encrypted_software" | "kms", encryptedSecret, encryptionNonce, authTag, keyVersion, dataKey, dataKeyVersion, kmsKeyId } };
  }

  async recordPublication(rotationId: string, publication: Record<string, unknown>): Promise<void> {
    await this.sql`update executor_rotations set publication = ${this.sql.json(publication as JSONValue)}, updated_at = now() where id = ${rotationId}`;
  }

  async published(rotationId: string, externalRef: Record<string, unknown>): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ organizationId: string }[]>`
        update executor_rotations set status = 'approval_required', external_ref = ${tx.json(externalRef as JSONValue)}, updated_at = now()
        where id = ${rotationId} and status = 'publishing' returning organization_id::text as "organizationId"
      `;
      if (!rows[0]) return;
      await tx`insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload) values (${rows[0].organizationId}, 'rotation.observe', 'executor_rotation', ${rotationId}, ${tx.json({ rotationId })})`;
    });
  }

  /** Moves the rotation on after an on-chain observation, scheduling the next step. */
  async observed(rotationId: string, outcome: "approved" | "rejected" | "pending"): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ organizationId: string; status: string }[]>`select organization_id::text as "organizationId", status from executor_rotations where id = ${rotationId} for update`;
      const rotation = rows[0];
      if (!rotation || rotation.status !== "approval_required") return;
      if (outcome === "pending") {
        await tx`insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload, available_at) values (${rotation.organizationId}, 'rotation.observe', 'executor_rotation', ${rotationId}, ${tx.json({ rotationId })}, now() + interval '5 seconds')`;
        return;
      }
      if (outcome === "rejected") {
        await tx`update executor_rotations set status = 'rejected', updated_at = now() where id = ${rotationId}`;
        return;
      }
      await tx`update executor_rotations set status = 'executing', updated_at = now() where id = ${rotationId}`;
      await tx`insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload) values (${rotation.organizationId}, 'rotation.execute', 'executor_rotation', ${rotationId}, ${tx.json({ rotationId })})`;
    });
  }

  /** The chain now lists the new executor: Relay starts using it. */
  async complete(rotationId: string, observedConfiguration: Record<string, unknown>): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ organizationId: string; treasuryId: string; toSignerId: string; fromSignerId: string }[]>`
        update executor_rotations set status = 'completed', updated_at = now() where id = ${rotationId} and status = 'executing'
        returning organization_id::text as "organizationId", treasury_account_id::text as "treasuryId", to_signer_id::text as "toSignerId", from_signer_id::text as "fromSignerId"
      `;
      const rotation = rows[0];
      if (!rotation) return;
      await tx`update treasury_accounts set executor_signer_id = ${rotation.toSignerId}, observed_configuration = observed_configuration || ${tx.json(observedConfiguration as JSONValue)}, updated_at = now() where id = ${rotation.treasuryId}`;
      await tx`
        insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
        values (${rotation.organizationId}, null, 'executor.rotated', 'treasury', ${rotation.treasuryId}, encode(digest(${rotationId}, 'sha256'), 'hex'), ${tx.json({ rotationId, from: rotation.fromSignerId, to: rotation.toSignerId })})
      `;
    });
  }

  async fail(rotationId: string, reason: string): Promise<void> {
    await this.sql`update executor_rotations set status = 'failed', failure_reason = ${reason.slice(0, 2000)}, updated_at = now() where id = ${rotationId} and status in ('publishing', 'approval_required', 'executing')`;
  }
}
