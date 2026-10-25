import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit';
import { withTransaction } from '../db';
import { AppError, notFound } from '../errors';
import {
  STATUS_SQL, THRESHOLD_SQL, applyMovement, assertBranch, assertProduct, findByIdempotencyKey, lockLevel, toMovement, type MoveInput
} from '../inventory';

const uuid = z.string().uuid();
const qty = z.number().int().min(1).max(1_000_000);
const text = (n: number) => z.string().trim().max(n).nullish().transform((v) => (v ? v : null));
const idem = z.string().trim().min(8).max(100).optional();

const receiptBody = z.object({ branchId: uuid, productId: uuid, quantity: qty, reference: text(100), reason: text(300), idempotencyKey: idem });
const adjustBody = z.object({
  branchId: uuid, productId: uuid, reason: z.string().trim().min(3).max(300), reference: text(100), idempotencyKey: idem,
  delta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, 'delta must not be zero')
});
const correctBody = z.object({
  branchId: uuid, productId: uuid, countedQuantity: z.number().int().min(0).max(10_000_000),
  reason: z.string().trim().min(3).max(300), idempotencyKey: idem
});
const transferBody = z.object({
  fromBranchId: uuid, toBranchId: uuid, productId: uuid, quantity: qty, reason: text(300), idempotencyKey: idem
}).refine((b) => b.fromBranchId !== b.toBranchId, { message: 'Source and destination branches must differ', path: ['toBranchId'] });
const thresholdBody = z.object({ branchId: uuid, productId: uuid, lowStockThreshold: z.number().int().min(0).max(1_000_000).nullable() });

const stockQuery = z.object({
  branchId: uuid.optional(), productId: uuid.optional(), categoryId: uuid.optional(),
  q: z.string().trim().max(100).optional(), status: z.enum(['ok', 'low', 'out']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0)
});
const movementQuery = z.object({
  branchId: uuid.optional(), productId: uuid.optional(),
  type: z.enum(['receipt', 'adjustment', 'transfer_out', 'transfer_in', 'correction']).optional(),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0)
});
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

const STOCK_BASE = `
  SELECT l.branch_id, b.name AS branch_name, b.code AS branch_code, l.product_id, p.sku, p.name AS product_name,
         c.name AS category_name, p.category_id, l.quantity, ${THRESHOLD_SQL} AS threshold,
         l.low_stock_threshold AS threshold_override, ${STATUS_SQL} AS status, p.cost_cents, trim(p.currency) AS currency, l.updated_at
  FROM inventory_levels l
  JOIN branches b ON b.id = l.branch_id AND b.org_id = l.org_id
  JOIN products p ON p.id = l.product_id AND p.org_id = l.org_id
  LEFT JOIN product_categories c ON c.id = p.category_id AND c.org_id = p.org_id
  WHERE l.org_id = $1`;

const toLevel = (r: any) => ({
  branchId: r.branch_id, branchName: r.branch_name, branchCode: r.branch_code, productId: r.product_id, sku: r.sku,
  productName: r.product_name, categoryName: r.category_name, quantity: r.quantity, threshold: r.threshold,
  thresholdOverride: r.threshold_override, status: r.status as 'ok' | 'low' | 'out', updatedAt: r.updated_at
});

export async function inventoryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  const staff = app.requireRole('owner', 'manager', 'employee');
  const managers = app.requireRole('owner', 'manager');

  /** Runs a stock operation in one transaction; a repeated idempotency key replays the first result. */
  async function runOp<T>(orgId: string, key: string | undefined, probe: string | undefined, op: (c: import('pg').PoolClient) => Promise<T>,
    replay: (m: any) => T) {
    try {
      return await withTransaction(app.pool, async (c) => {
        if (key && probe) {
          const existing = await findByIdempotencyKey(c, orgId, probe);
          if (existing) return replay(existing);
        }
        return op(c);
      });
    } catch (e) {
      if (key && probe && (e as { code?: string }).code === '23505') {
        const c = await app.pool.connect();
        try { const existing = await findByIdempotencyKey(c, orgId, probe); if (existing) return replay(existing); } finally { c.release(); }
      }
      throw e;
    }
  }

  const base = (req: any): Pick<MoveInput, 'orgId' | 'userId'> => ({ orgId: req.auth.orgId, userId: req.auth.userId });

  app.get('/', async (req) => {
    const q = stockQuery.parse(req.query);
    const params: unknown[] = [req.auth.orgId]; let where = '';
    const add = (sql: string, v: unknown) => { params.push(v); where += ` AND ${sql.replace('?', `$${params.length}`)}`; };
    if (q.branchId) add('x.branch_id = ?', q.branchId);
    if (q.productId) add('x.product_id = ?', q.productId);
    if (q.categoryId) add('x.category_id = ?', q.categoryId);
    if (q.status) add('x.status = ?', q.status);
    if (q.q) add('(x.product_name ILIKE ? OR x.sku ILIKE ?)'.replace('?', `$${params.length + 1}`).replace('?', `$${params.length + 1}`), `%${escapeLike(q.q)}%`);
    const cte = `WITH x AS (${STOCK_BASE})`;
    const countParams = [...params]; params.push(q.limit, q.offset);
    const { rows } = await app.pool.query(`${cte} SELECT * FROM x WHERE true ${where} ORDER BY product_name, branch_name LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const total = await app.pool.query(`${cte} SELECT count(*)::int AS n FROM x WHERE true ${where}`, countParams);
    return { levels: rows.map(toLevel), total: total.rows[0].n };
  });

  app.get('/alerts', async (req) => {
    const { rows } = await app.pool.query(
      `WITH x AS (${STOCK_BASE}) SELECT * FROM x WHERE status IN ('low','out')
       ORDER BY (status = 'out') DESC, quantity::float / GREATEST(threshold, 1), product_name LIMIT 200`, [req.auth.orgId]);
    return { alerts: rows.map(toLevel), outCount: rows.filter((r) => r.status === 'out').length, lowCount: rows.filter((r) => r.status === 'low').length };
  });

  app.get('/movements', async (req) => {
    const q = movementQuery.parse(req.query);
    const params: unknown[] = [req.auth.orgId]; let where = 'm.org_id = $1';
    const add = (sql: string, v: unknown) => { params.push(v); where += ` AND ${sql.replace('?', `$${params.length}`)}`; };
    if (q.branchId) add('m.branch_id = ?', q.branchId);
    if (q.productId) add('m.product_id = ?', q.productId);
    if (q.type) add('m.type = ?', q.type);
    if (q.from) add('m.created_at >= ?', q.from);
    if (q.to) add('m.created_at <= ?', q.to);
    const countParams = [...params]; params.push(q.limit, q.offset);
    const { rows } = await app.pool.query(
      `SELECT m.*, b.name AS branch_name, p.name AS product_name, p.sku, u.full_name AS created_by_name
       FROM stock_movements m JOIN branches b ON b.id = m.branch_id JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.created_by WHERE ${where}
       ORDER BY m.seq DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const total = await app.pool.query(`SELECT count(*)::int AS n FROM stock_movements m WHERE ${where}`, countParams);
    return { movements: rows.map(toMovement), total: total.rows[0].n };
  });

  app.post('/receipts', { preHandler: staff }, async (req, reply) => {
    const b = receiptBody.parse(req.body);
    const out = await runOp(req.auth.orgId, b.idempotencyKey, b.idempotencyKey, async (c) => {
      const m = await applyMovement(c, { ...base(req), branchId: b.branchId, productId: b.productId, type: 'receipt', delta: b.quantity, reason: b.reason, reference: b.reference, idempotencyKey: b.idempotencyKey });
      await writeAudit(c, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'inventory.receipt', entityType: 'product', entityId: b.productId, metadata: { branchId: b.branchId, quantity: b.quantity, reference: b.reference }, ip: req.ip });
      return { movement: toMovement(m), replayed: false };
    }, (m) => ({ movement: toMovement(m), replayed: true }));
    return reply.status(out.replayed ? 200 : 201).send(out);
  });

  app.post('/adjustments', { preHandler: managers }, async (req, reply) => {
    const b = adjustBody.parse(req.body);
    const out = await runOp(req.auth.orgId, b.idempotencyKey, b.idempotencyKey, async (c) => {
      const m = await applyMovement(c, { ...base(req), branchId: b.branchId, productId: b.productId, type: 'adjustment', delta: b.delta, reason: b.reason, reference: b.reference, idempotencyKey: b.idempotencyKey });
      await writeAudit(c, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'inventory.adjustment', entityType: 'product', entityId: b.productId, metadata: { branchId: b.branchId, delta: b.delta, reason: b.reason }, ip: req.ip });
      return { movement: toMovement(m), replayed: false };
    }, (m) => ({ movement: toMovement(m), replayed: true }));
    return reply.status(out.replayed ? 200 : 201).send(out);
  });

  /** Physical count: sets the on-hand quantity to what was counted; the difference is recorded as a correction. */
  app.post('/corrections', { preHandler: managers }, async (req, reply) => {
    const b = correctBody.parse(req.body);
    const out = await runOp(req.auth.orgId, b.idempotencyKey, b.idempotencyKey, async (c) => {
      await assertBranch(c, req.auth.orgId, b.branchId); await assertProduct(c, req.auth.orgId, b.productId);
      const current = await lockLevel(c, req.auth.orgId, b.branchId, b.productId);
      const delta = b.countedQuantity - current;
      if (delta === 0) return { movement: null, unchanged: true, replayed: false };
      const m = await applyMovement(c, { ...base(req), branchId: b.branchId, productId: b.productId, type: 'correction', delta, reason: b.reason, idempotencyKey: b.idempotencyKey });
      await writeAudit(c, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'inventory.correction', entityType: 'product', entityId: b.productId, metadata: { branchId: b.branchId, from: current, to: b.countedQuantity, reason: b.reason }, ip: req.ip });
      return { movement: toMovement(m), unchanged: false, replayed: false };
    }, (m) => ({ movement: toMovement(m), unchanged: false, replayed: true }));
    return reply.status(out.movement && !out.replayed ? 201 : 200).send(out);
  });

  app.post('/transfers', { preHandler: managers }, async (req, reply) => {
    const b = transferBody.parse(req.body);
    const probe = b.idempotencyKey ? `${b.idempotencyKey}:out` : undefined;
    const out = await runOp(req.auth.orgId, b.idempotencyKey, probe, async (c) => {
      await assertBranch(c, req.auth.orgId, b.fromBranchId); await assertBranch(c, req.auth.orgId, b.toBranchId); await assertProduct(c, req.auth.orgId, b.productId);
      // Lock both rows in a fixed order so opposite transfers can never deadlock.
      for (const id of [b.fromBranchId, b.toBranchId].sort()) await lockLevel(c, req.auth.orgId, id, b.productId);
      const transferId = randomUUID();
      const common = { ...base(req), productId: b.productId, transferId, reason: b.reason };
      const o = await applyMovement(c, { ...common, branchId: b.fromBranchId, type: 'transfer_out', delta: -b.quantity, idempotencyKey: b.idempotencyKey ? `${b.idempotencyKey}:out` : null });
      const i = await applyMovement(c, { ...common, branchId: b.toBranchId, type: 'transfer_in', delta: b.quantity, idempotencyKey: b.idempotencyKey ? `${b.idempotencyKey}:in` : null });
      await writeAudit(c, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'inventory.transfer', entityType: 'product', entityId: b.productId, metadata: { from: b.fromBranchId, to: b.toBranchId, quantity: b.quantity, transferId }, ip: req.ip });
      return { transferId, out: toMovement(o), in: toMovement(i), replayed: false };
    }, (m) => ({ transferId: m.transfer_id, out: toMovement(m), in: null as any, replayed: true }));
    return reply.status(out.replayed ? 200 : 201).send(out);
  });

  app.patch('/threshold', { preHandler: managers }, async (req) => {
    const b = thresholdBody.parse(req.body);
    await withTransaction(app.pool, async (c) => {
      await assertBranch(c, req.auth.orgId, b.branchId); await assertProduct(c, req.auth.orgId, b.productId);
      await lockLevel(c, req.auth.orgId, b.branchId, b.productId);
      await c.query('UPDATE inventory_levels SET low_stock_threshold = $4, updated_at = now() WHERE branch_id = $1 AND product_id = $2 AND org_id = $3',
        [b.branchId, b.productId, req.auth.orgId, b.lowStockThreshold]);
      await writeAudit(c, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'inventory.threshold', entityType: 'product', entityId: b.productId, metadata: { branchId: b.branchId, lowStockThreshold: b.lowStockThreshold }, ip: req.ip });
    });
    const { rows } = await app.pool.query(`WITH x AS (${STOCK_BASE}) SELECT * FROM x WHERE branch_id = $2 AND product_id = $3`, [req.auth.orgId, b.branchId, b.productId]);
    if (!rows[0]) throw new AppError(404, 'Stock row not found', 'not_found');
    return { level: toLevel(rows[0]) };
  });

  /** All figures are computed live from stock_levels / stock_movements. Value is at product unit cost, never summed across currencies. */
  app.get('/analytics', async (req) => {
    const org = req.auth.orgId;
    const [byBranch, byCategory, statuses, moves] = await Promise.all([
      app.pool.query(`WITH x AS (${STOCK_BASE}) SELECT branch_id, branch_name, currency, sum(quantity)::int AS units,
          count(*) FILTER (WHERE quantity > 0)::int AS skus, sum(quantity::bigint * cost_cents)::bigint AS value_cents
          FROM x GROUP BY branch_id, branch_name, currency ORDER BY branch_name`, [org]),
      app.pool.query(`WITH x AS (${STOCK_BASE}) SELECT COALESCE(category_name, 'Uncategorized') AS category, sum(quantity)::int AS units
          FROM x GROUP BY 1 ORDER BY units DESC`, [org]),
      app.pool.query(`WITH x AS (${STOCK_BASE}) SELECT status, count(*)::int AS n FROM x GROUP BY status`, [org]),
      app.pool.query(`SELECT type, count(*)::int AS n, COALESCE(sum(quantity_delta) FILTER (WHERE quantity_delta > 0),0)::int AS units_in,
          COALESCE(-sum(quantity_delta) FILTER (WHERE quantity_delta < 0),0)::int AS units_out
          FROM stock_movements WHERE org_id = $1 AND created_at >= now() - interval '30 days' GROUP BY type ORDER BY type`, [org])
    ]);
    const branches = new Map<string, any>();
    for (const r of byBranch.rows) {
      const b = branches.get(r.branch_id) ?? { branchId: r.branch_id, branchName: r.branch_name, units: 0, skus: 0, valueAtCost: [] };
      b.units += r.units; b.skus += r.skus; b.valueAtCost.push({ currency: r.currency, cents: r.value_cents });
      branches.set(r.branch_id, b);
    }
    const status = { ok: 0, low: 0, out: 0 } as Record<string, number>;
    for (const r of statuses.rows) status[r.status] = r.n;
    return {
      generatedAt: new Date().toISOString(), dataSource: 'live', valuationBasis: 'quantity x product unit cost',
      byBranch: [...branches.values()], byCategory: byCategory.rows, statusCounts: status,
      movements30d: moves.rows.map((r) => ({ type: r.type, count: r.n, unitsIn: r.units_in, unitsOut: r.units_out }))
    };
  });
}
