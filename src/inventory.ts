import type { PoolClient } from 'pg';
import { conflict, notFound } from './errors';

export type MovementType = 'receipt' | 'adjustment' | 'transfer_out' | 'transfer_in' | 'correction';

export interface MoveInput {
  orgId: string; userId: string; branchId: string; productId: string; type: MovementType;
  delta: number; reason?: string | null; reference?: string | null; transferId?: string | null; idempotencyKey?: string | null;
}

export const toMovement = (r: any) => ({
  id: r.id, branchId: r.branch_id, productId: r.product_id, type: r.type, quantityDelta: r.quantity_delta,
  balanceAfter: r.balance_after, reason: r.reason, reference: r.reference, transferId: r.transfer_id, createdAt: r.created_at,
  ...(r.branch_name !== undefined ? { branchName: r.branch_name, productName: r.product_name, sku: r.sku, createdByName: r.created_by_name } : {})
});

/** SQL expression for the stock status of a level row `l` joined to product `p`. */
export const THRESHOLD_SQL = 'COALESCE(l.low_stock_threshold, p.reorder_level)';
export const STATUS_SQL = `CASE WHEN l.quantity = 0 THEN 'out'
  WHEN ${THRESHOLD_SQL} > 0 AND l.quantity <= ${THRESHOLD_SQL} THEN 'low' ELSE 'ok' END`;

export async function assertBranch(c: PoolClient, orgId: string, branchId: string) {
  const r = await c.query('SELECT id, status FROM branches WHERE id = $1 AND org_id = $2', [branchId, orgId]);
  if (!r.rowCount) throw notFound('Branch');
  return r.rows[0] as { id: string; status: string };
}
export async function assertProduct(c: PoolClient, orgId: string, productId: string) {
  const r = await c.query('SELECT id FROM products WHERE id = $1 AND org_id = $2', [productId, orgId]);
  if (!r.rowCount) throw notFound('Product');
}

/** Creates the level row if missing, then locks it. All stock changes serialize on this row lock. */
export async function lockLevel(c: PoolClient, orgId: string, branchId: string, productId: string): Promise<number> {
  await c.query(
    `INSERT INTO inventory_levels (org_id, branch_id, product_id, quantity) VALUES ($1,$2,$3,0)
     ON CONFLICT (branch_id, product_id) DO NOTHING`, [orgId, branchId, productId]);
  const r = await c.query(
    'SELECT quantity FROM inventory_levels WHERE branch_id = $1 AND product_id = $2 AND org_id = $3 FOR UPDATE',
    [branchId, productId, orgId]);
  return r.rows[0].quantity as number;
}

export async function findByIdempotencyKey(c: PoolClient, orgId: string, key: string) {
  const r = await c.query('SELECT * FROM stock_movements WHERE org_id = $1 AND idempotency_key = $2', [orgId, key]);
  return r.rows[0] ?? null;
}

/**
 * The single place where stock changes. Must run inside a transaction.
 * Locks the level row, refuses to go below zero, updates the balance and appends a ledger row.
 */
export async function applyMovement(c: PoolClient, m: MoveInput) {
  const branch = await assertBranch(c, m.orgId, m.branchId);
  await assertProduct(c, m.orgId, m.productId);
  if (m.delta > 0 && branch.status !== 'active') throw conflict('This branch is inactive and cannot receive stock');
  const current = await lockLevel(c, m.orgId, m.branchId, m.productId);
  const next = current + m.delta;
  if (next < 0) throw conflict(`Insufficient stock: ${current} on hand, change of ${m.delta} would make it negative`);
  await c.query('UPDATE inventory_levels SET quantity = $4, updated_at = now() WHERE branch_id = $1 AND product_id = $2 AND org_id = $3',
    [m.branchId, m.productId, m.orgId, next]);
  const ins = await c.query(
    `INSERT INTO stock_movements (org_id, branch_id, product_id, type, quantity_delta, balance_after, reason, reference, transfer_id, idempotency_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [m.orgId, m.branchId, m.productId, m.type, m.delta, next, m.reason ?? null, m.reference ?? null, m.transferId ?? null, m.idempotencyKey ?? null, m.userId]);
  return ins.rows[0];
}
