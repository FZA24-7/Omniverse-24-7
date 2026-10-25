import type { Pool, PoolClient } from 'pg';

export interface AuditEntry {
  orgId: string;
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export async function writeAudit(db: Pool | PoolClient, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, metadata, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.orgId, e.actorUserId, e.action, e.entityType ?? null, e.entityId ?? null, JSON.stringify(e.metadata ?? {}), e.ip ?? null]
  );
}
