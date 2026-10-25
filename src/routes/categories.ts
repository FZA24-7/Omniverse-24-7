import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit';
import { conflict, notFound } from '../errors';

const body = z.object({ name: z.string().trim().min(1).max(80) });
const idParam = z.object({ id: z.string().uuid() });

export async function categoryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  const canWrite = app.requireRole('owner', 'manager');
  const dup = (e: unknown) => { if ((e as { code?: string }).code === '23505') throw conflict('A category with this name already exists'); throw e; };

  app.get('/', async (req) => {
    const { rows } = await app.pool.query(
      `SELECT c.id, c.name, count(p.id)::int AS product_count FROM product_categories c
       LEFT JOIN products p ON p.category_id = c.id WHERE c.org_id = $1 GROUP BY c.id ORDER BY lower(c.name)`, [req.auth.orgId]);
    return { categories: rows.map((r) => ({ id: r.id, name: r.name, productCount: r.product_count })) };
  });

  app.post('/', { preHandler: canWrite }, async (req, reply) => {
    const b = body.parse(req.body);
    try {
      const { rows } = await app.pool.query('INSERT INTO product_categories (org_id, name) VALUES ($1,$2) RETURNING id, name', [req.auth.orgId, b.name]);
      await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'category.created', entityType: 'category', entityId: rows[0].id, ip: req.ip });
      return reply.status(201).send({ category: { id: rows[0].id, name: rows[0].name, productCount: 0 } });
    } catch (e) { return dup(e); }
  });

  app.patch('/:id', { preHandler: canWrite }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = body.parse(req.body);
    try {
      const { rows } = await app.pool.query('UPDATE product_categories SET name = $3 WHERE id = $1 AND org_id = $2 RETURNING id, name', [id, req.auth.orgId, b.name]);
      if (!rows[0]) throw notFound('Category');
      await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'category.updated', entityType: 'category', entityId: id, ip: req.ip });
      return { category: rows[0] };
    } catch (e) { return dup(e); }
  });

  app.delete('/:id', { preHandler: canWrite }, async (req) => {
    const { id } = idParam.parse(req.params);
    // Products in this category become uncategorized.
    await app.pool.query('UPDATE products SET category_id = NULL WHERE category_id = $1 AND org_id = $2', [id, req.auth.orgId]);
    const r = await app.pool.query('DELETE FROM product_categories WHERE id = $1 AND org_id = $2', [id, req.auth.orgId]);
    if (!r.rowCount) throw notFound('Category');
    await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'category.deleted', entityType: 'category', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
