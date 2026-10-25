import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit';
import { AppError, conflict, forbidden, notFound } from '../errors';

const assignableRole = z.enum(['owner', 'manager', 'employee', 'readonly']);
const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  fullName: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(200),
  role: assignableRole
});
const patchSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  role: assignableRole.optional(),
  isActive: z.boolean().optional()
});
const idParam = z.object({ id: z.string().uuid() });

const toUser = (u: any) => ({
  id: u.id, email: u.email, fullName: u.full_name, role: u.role, isActive: u.is_active,
  lastLoginAt: u.last_login_at, createdAt: u.created_at
});

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/', { preHandler: app.requireRole('owner', 'manager') }, async (req) => {
    const { rows } = await app.pool.query('SELECT * FROM users WHERE org_id = $1 ORDER BY created_at', [req.auth.orgId]);
    return { users: rows.map(toUser) };
  });

  app.post('/', { preHandler: app.requireRole('owner') }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const dup = await app.pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [body.email]);
    if (dup.rowCount) throw conflict('An account with this email already exists');
    const hash = await bcrypt.hash(body.password, app.cfg.BCRYPT_ROUNDS);
    const { rows } = await app.pool.query(
      `INSERT INTO users (org_id, email, full_name, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.auth.orgId, body.email, body.fullName, hash, body.role]
    );
    await writeAudit(app.pool, {
      orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'user.created',
      entityType: 'user', entityId: rows[0].id, metadata: { role: body.role }, ip: req.ip
    });
    return reply.status(201).send({ user: toUser(rows[0]) });
  });

  app.patch('/:id', { preHandler: app.requireRole('owner') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = patchSchema.parse(req.body);
    if (id === req.auth.userId && (body.role !== undefined || body.isActive === false)) {
      throw forbidden('You cannot change your own role or deactivate yourself');
    }
    const cur = await app.pool.query('SELECT * FROM users WHERE id = $1 AND org_id = $2', [id, req.auth.orgId]);
    if (!cur.rowCount) throw notFound('User');
    if (cur.rows[0].role === 'platform_admin') throw forbidden();
    const { rows } = await app.pool.query(
      `UPDATE users SET full_name = COALESCE($3, full_name), role = COALESCE($4::user_role, role),
              is_active = COALESCE($5, is_active)
       WHERE id = $1 AND org_id = $2 RETURNING *`,
      [id, req.auth.orgId, body.fullName ?? null, body.role ?? null, body.isActive ?? null]
    );
    if (body.isActive === false) {
      await app.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    await writeAudit(app.pool, {
      orgId: req.auth.orgId, actorUserId: req.auth.userId, action: 'user.updated',
      entityType: 'user', entityId: id, metadata: body as Record<string, unknown>, ip: req.ip
    });
    return { user: toUser(rows[0]) };
  });
}
