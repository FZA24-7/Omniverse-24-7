import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from './errors';

export type Role = 'platform_admin' | 'owner' | 'manager' | 'employee' | 'readonly';

export interface AuthContext {
  userId: string;
  orgId: string;
  role: Role;
  email: string;
  fullName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: Role[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Authentication is verified against the database on every request: the role,
 * organization and active flag always come from the users table, never from the
 * token. A deactivated user or a changed role takes effect immediately.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorate('authenticate', async (req: FastifyRequest) => {
    let payload: { sub?: string };
    try {
      payload = await req.jwtVerify<{ sub?: string }>();
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    if (!payload.sub) throw unauthorized('Invalid token');
    const { rows } = await app.pool.query(
      `SELECT id, org_id, role, email, full_name, is_active FROM users WHERE id = $1`,
      [payload.sub]
    );
    const u = rows[0];
    if (!u || !u.is_active) throw unauthorized('Account is not active');
    req.auth = { userId: u.id, orgId: u.org_id, role: u.role, email: u.email, fullName: u.full_name };
  });

  app.decorate('requireRole', (...roles: Role[]) => async (req: FastifyRequest) => {
    if (!req.auth) throw unauthorized();
    if (req.auth.role === 'platform_admin') return;
    if (!roles.includes(req.auth.role)) throw forbidden();
  });
}
