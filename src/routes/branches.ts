import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit';
import { conflict, notFound } from '../errors';

const opt = (n: number) => z.string().trim().max(n).nullish().transform((v) => (v ? v : null));
const createBody = z.object({
  code: z.string().trim().min(1).max(32), name: z.string().trim().min(1).max(120), address: opt(300), city: opt(100)
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(), address: opt(300).optional(), city: opt(100).optional(),
  status: z.enum(['active', 'inactive']).optional()
});
const idParam = z.object({ id: z.string().uuid() });

const toBranch = (r: any) => ({
  id: r.id, code: r.code, name: r.name, address: r.address, city: r.city, status: r.status,
  createdAt: r.created_at, ...(r.units !== undefined ? { stockedProducts: r.stocked_products, totalUnits: r.units } : {})
});

export async function branchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  const canWrite = app.requireRole('owner', 'manager');

  app.get('/', async (req) => {
    const { rows } = await app.pool.query(
      `SELECT b.*, COALESCE(sum(l.quantity),0)::int AS units, count(l.product_id) FILTER (WHERE l.quantity > 0)::int AS stocked_products
       FROM branches b LEFT JOIN inventory_levels l ON l.branch_id = b.id
       WHERE b.org_id = $1 GROUP BY b.id ORDER BY b.name`, [req.auth.orgId]);
    return { branches: rows.map(toBranch) };
  });

  app.post('/', { preHandler: canWrite }, async (req, reply) => {
    const b = createBody.parse(req.body);
    try {
      const { rows } = await app.pool.query(
        'INSERT INTO branches (org_id, code, name, address, city) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [req.auth.orgId, b.code, b.name, b.address, b.city]);
      await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'branch.created', entityType: 'branch', entityId: rows[0].id, ip: req.ip });
      return reply.status(201).send({ branch: toBranch(rows[0]) });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict(`Branch code "${b.code}" already exists`);
      throw e;
    }
  });

  app.patch('/:id', { preHandler: canWrite }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = patchBody.parse(req.body);
    const { rows } = await app.pool.query(
      `UPDATE branches SET name = COALESCE($3, name), address = CASE WHEN $4::boolean THEN $5 ELSE address END,
         city = CASE WHEN $6::boolean THEN $7 ELSE city END, status = COALESCE($8, status), updated_at = now()
       WHERE id = $1 AND org_id = $2 RETURNING *`,
      [id, req.auth.orgId, b.name ?? null, b.address !== undefined, b.address ?? null, b.city !== undefined, b.city ?? null, b.status ?? null]);
    if (!rows[0]) throw notFound('Branch');
    await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'branch.updated', entityType: 'branch', entityId: id, metadata: b as Record<string, unknown>, ip: req.ip });
    return { branch: toBranch(rows[0]) };
  });
}
