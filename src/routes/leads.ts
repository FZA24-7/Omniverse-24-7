import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit';
import { notFound } from '../errors';

const STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] as const;
const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

const leadBody = z.object({
  name: z.string().trim().min(1).max(160),
  company: opt(160),
  email: z.string().trim().email().max(254).nullish().transform((v) => v ?? null),
  phone: opt(40),
  source: opt(80),
  stage: z.enum(STAGES).default('new'),
  valueCents: z.number().int().min(0).max(1_000_000_000_000).default(0),
  currency: z.string().length(3).toUpperCase().default('USD'),
  notes: opt(4000)
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  company: opt(160).optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  phone: opt(40).optional(),
  source: opt(80).optional(),
  stage: z.enum(STAGES).optional(),
  valueCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  notes: opt(4000).optional()
});
const listQuery = z.object({
  stage: z.enum(STAGES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});
const idParam = z.object({ id: z.string().uuid() });

const toLead = (r: any) => ({
  id: r.id, name: r.name, company: r.company, email: r.email, phone: r.phone, source: r.source,
  stage: r.stage, valueCents: r.value_cents, currency: r.currency.trim(), notes: r.notes,
  createdAt: r.created_at, updatedAt: r.updated_at
});

export async function leadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  const canWrite = app.requireRole('owner', 'manager', 'employee');
  const canDelete = app.requireRole('owner', 'manager');

  app.get('/', async (req) => {
    const q = listQuery.parse(req.query);
    const params: unknown[] = [req.auth.orgId];
    let where = 'org_id = $1';
    if (q.stage) { params.push(q.stage); where += ` AND stage = $${params.length}`; }
    params.push(q.limit, q.offset);
    const { rows } = await app.pool.query(
      `SELECT * FROM leads WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    const total = await app.pool.query(`SELECT count(*)::int AS n FROM leads WHERE ${where}`, params.slice(0, params.length - 2));
    return { leads: rows.map(toLead), total: total.rows[0].n };
  });

  app.get('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await app.pool.query('SELECT * FROM leads WHERE id = $1 AND org_id = $2', [id, req.auth.orgId]);
    if (!rows[0]) throw notFound('Lead');
    return { lead: toLead(rows[0]) };
  });

  app.post('/', { preHandler: canWrite }, async (req, reply) => {
    const b = leadBody.parse(req.body);
    const { rows } = await app.pool.query(
      `INSERT INTO leads (org_id, name, company, email, phone, source, stage, value_cents, currency, notes, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.auth.orgId, b.name, b.company, b.email, b.phone, b.source, b.stage, b.valueCents, b.currency, b.notes, req.auth.userId]
    );
    await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'lead.created', entityType: 'lead', entityId: rows[0].id, ip: req.ip });
    return reply.status(201).send({ lead: toLead(rows[0]) });
  });

  app.patch('/:id', { preHandler: canWrite }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = patchBody.parse(req.body);
    const cols: Record<string, unknown> = {
      name: b.name, company: b.company, email: b.email, phone: b.phone, source: b.source,
      stage: b.stage, value_cents: b.valueCents, currency: b.currency, notes: b.notes
    };
    const sets: string[] = [];
    const params: unknown[] = [id, req.auth.orgId];
    for (const [col, val] of Object.entries(cols)) {
      if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); }
    }
    if (!sets.length) {
      const cur = await app.pool.query('SELECT * FROM leads WHERE id = $1 AND org_id = $2', [id, req.auth.orgId]);
      if (!cur.rows[0]) throw notFound('Lead');
      return { lead: toLead(cur.rows[0]) };
    }
    const { rows } = await app.pool.query(
      `UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`, params
    );
    if (!rows[0]) throw notFound('Lead');
    await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'lead.updated', entityType: 'lead', entityId: id, metadata: { fields: Object.keys(b) }, ip: req.ip });
    return { lead: toLead(rows[0]) };
  });

  app.delete('/:id', { preHandler: canDelete }, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = await app.pool.query('DELETE FROM leads WHERE id = $1 AND org_id = $2', [id, req.auth.orgId]);
    if (!r.rowCount) throw notFound('Lead');
    await writeAudit(app.pool, { orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'lead.deleted', entityType: 'lead', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
