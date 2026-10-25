import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

const q = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.get('/', { preHandler: app.requireRole('owner', 'manager') }, async (req) => {
    const { limit, offset } = q.parse(req.query);
    const { rows } = await app.pool.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at, u.full_name AS actor
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.org_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT $2 OFFSET $3`,
      [req.auth.orgId, limit, offset]
    );
    return {
      entries: rows.map((r) => ({
        id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
        metadata: r.metadata, actor: r.actor, createdAt: r.created_at
      }))
    };
  });
}
