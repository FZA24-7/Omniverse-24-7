import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { writeAudit } from '../audit';
import { AppError, conflict, notFound } from '../errors';

const desc = z.string().trim().max(4000).nullish().transform((v) => (v ? v : null));
const money = z.number().int().min(0).max(1_000_000_000_000);
const createBody = z.object({
  sku: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(160), description: desc,
  priceCents: money.default(0), costCents: money.default(0), currency: z.string().length(3).toUpperCase().default('USD'),
  reorderLevel: z.number().int().min(0).max(1_000_000).default(0), categoryId: z.string().uuid().nullish().transform((v) => v ?? null)
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(160).optional(), description: desc.optional(), priceCents: money.optional(),
  costCents: money.optional(), reorderLevel: z.number().int().min(0).max(1_000_000).optional(), isActive: z.boolean().optional(),
  categoryId: z.string().uuid().nullable().optional()
});
const listQuery = z.object({
  q: z.string().trim().max(100).optional(), categoryId: z.string().uuid().optional(),
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0)
});
const idParam = z.object({ id: z.string().uuid() });
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

const toProduct = (r: any) => ({
  id: r.id, sku: r.sku, name: r.name, description: r.description, priceCents: r.price_cents, costCents: r.cost_cents,
  currency: r.currency.trim(), reorderLevel: r.reorder_level, isActive: r.is_active, categoryId: r.category_id,
  categoryName: r.category_name ?? null, onHand: r.on_hand ?? 0, createdAt: r.created_at, updatedAt: r.updated_at
});
const SELECT = `SELECT p.*, c.name AS category_name,
  COALESCE((SELECT sum(l.quantity) FROM inventory_levels l WHERE l.product_id = p.id AND l.org_id = p.org_id), 0)::int AS on_hand
  FROM products p LEFT JOIN product_categories c ON c.id = p.category_id AND c.org_id = p.org_id`;

async function assertCategory(pool: Pool, orgId: string, id: string | null | undefined) {
  if (!id) return;
  const r = await pool.query('SELECT 1 FROM product_categories WHERE id = $1 AND org_id = $2', [id, orgId]);
  if (!r.rowCount) throw new AppError(400, 'Category not found in your organization', 'invalid_category');
}

export async function productRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  const canWrite = app.requireRole('owner', 'manager');
  const one = async (orgId: string, id: string) => {
    const { rows } = await app.pool.query(`${SELECT} WHERE p.id = $1 AND p.org_id = $2`, [id, orgId]);
    if (!rows[0]) throw notFound('Product');
    return toProduct(rows[0]);
  };

  app.get('/', async (req) => {
    const q = listQuery.parse(req.query);
    const params: unknown[] = [req.auth.orgId];
    let where = 'p.org_id = $1';
    if (q.q) { params.push(`%${escapeLike(q.q)}%`); where += ` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`; }
    if (q.categoryId) { params.push(q.categoryId); where += ` AND p.category_id = $${params.length}`; }
    if (q.active) { params.push(q.active === 'true'); where += ` AND p.is_active = $${params.length}`; }
    const countParams = [...params];
    params.push(q.limit, q.offset);
    const { rows } = await app.pool.query(`${SELECT} WHERE ${where} ORDER BY p.name, p.sku LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const total = await app.pool.query(`SELECT count(*)::int AS n FROM products p WHERE ${where}`, countParams);
    return { products: rows.map(toProduct), total: total.rows[0].n };
  });

  app.get('/:id', async (req) => ({ product: await one(req.auth.orgId, idParam.parse(req.params).id) }));

  app.post('/', { preHandler: canWrite }, async (req, reply) => {
    const b = createBody.parse(req.body);
    await assertCategory(app.pool, req.auth.orgId, b.categoryId);
    try {
      const { rows } = await app.pool.query(
        `INSERT INTO products (org_id, sku, name, description, price_cents, cost_cents, currency, reorder_level, category_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [req.auth.orgId, b.sku, b.name, b.description, b.priceCents, b.costCents, b.currency, b.reorderLevel, b.categoryId]);
      await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'product.created', entityType: 'product', entityId: rows[0].id, ip: req.ip });
      return reply.status(201).send({ product: await one(req.auth.orgId, rows[0].id) });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict(`SKU "${b.sku}" already exists`);
      throw err;
    }
  });

  app.patch('/:id', { preHandler: canWrite }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = patchBody.parse(req.body);
    if (b.categoryId) await assertCategory(app.pool, req.auth.orgId, b.categoryId);
    const cols: Record<string, unknown> = {
      name: b.name, description: b.description, price_cents: b.priceCents, cost_cents: b.costCents,
      reorder_level: b.reorderLevel, is_active: b.isActive, category_id: b.categoryId
    };
    const sets: string[] = []; const params: unknown[] = [id, req.auth.orgId];
    for (const [col, val] of Object.entries(cols)) if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); }
    if (sets.length) {
      const r = await app.pool.query(`UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND org_id = $2`, params);
      if (!r.rowCount) throw notFound('Product');
      await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'product.updated', entityType: 'product', entityId: id, metadata: { fields: Object.keys(b) }, ip: req.ip });
    }
    return { product: await one(req.auth.orgId, id) };
  });

  app.delete('/:id', { preHandler: canWrite }, async (req) => {
    const { id } = idParam.parse(req.params);
    try {
      const r = await app.pool.query('DELETE FROM products WHERE id = $1 AND org_id = $2', [id, req.auth.orgId]);
      if (!r.rowCount) throw notFound('Product');
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw conflict('This product has stock history and cannot be deleted. Deactivate it instead.');
      throw e;
    }
    await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'product.deleted', entityType: 'product', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
