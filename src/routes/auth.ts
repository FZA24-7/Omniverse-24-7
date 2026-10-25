import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../db';
import { writeAudit } from '../audit';
import { AppError, conflict, unauthorized } from '../errors';

const password = z.string().min(10, 'Password must be at least 10 characters').max(200);
const email = z.string().trim().toLowerCase().email().max(254);

const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  fullName: z.string().trim().min(1).max(120),
  email,
  password
});
const loginSchema = z.object({ email, password: z.string().min(1).max(200) });
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(300) });

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

export async function authRoutes(app: FastifyInstance) {
  const limit = { config: { rateLimit: { max: app.cfg.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } } };

  async function issueTokens(userId: string) {
    const accessToken = app.jwt.sign({ sub: userId }, { expiresIn: `${app.cfg.ACCESS_TOKEN_TTL_SECONDS}s` });
    const refreshToken = crypto.randomBytes(48).toString('base64url');
    const expires = new Date(Date.now() + app.cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await app.pool.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [
      userId, hashToken(refreshToken), expires
    ]);
    return { accessToken, refreshToken, expiresIn: app.cfg.ACCESS_TOKEN_TTL_SECONDS };
  }

  const publicUser = (u: any) => ({
    id: u.id, email: u.email, fullName: u.full_name, role: u.role, orgId: u.org_id, orgName: u.org_name
  });

  app.post('/register-organization', limit, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const hash = await bcrypt.hash(body.password, app.cfg.BCRYPT_ROUNDS);
    const user = await withTransaction(app.pool, async (c) => {
      const exists = await c.query('SELECT 1 FROM users WHERE lower(email) = $1', [body.email]);
      if (exists.rowCount) throw conflict('An account with this email already exists');
      const slug = `${slugify(body.organizationName)}-${crypto.randomBytes(3).toString('hex')}`;
      const org = await c.query('INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id, name', [
        body.organizationName, slug
      ]);
      const u = await c.query(
        `INSERT INTO users (org_id, email, full_name, password_hash, role)
         VALUES ($1,$2,$3,$4,'owner') RETURNING id, org_id, email, full_name, role`,
        [org.rows[0].id, body.email, body.fullName, hash]
      );
      await writeAudit(c, {
        orgId: org.rows[0].id, actorUserId: u.rows[0].id, action: 'organization.created',
        entityType: 'organization', entityId: org.rows[0].id, ip: req.ip
      });
      return { ...u.rows[0], org_name: org.rows[0].name };
    });
    const tokens = await issueTokens(user.id);
    return reply.status(201).send({ user: publicUser(user), ...tokens });
  });

  app.post('/login', limit, async (req) => {
    const body = loginSchema.parse(req.body);
    const { rows } = await app.pool.query(
      `SELECT u.*, o.name AS org_name FROM users u JOIN organizations o ON o.id = u.org_id WHERE lower(u.email) = $1`,
      [body.email]
    );
    const u = rows[0];
    const invalid = new AppError(401, 'Invalid email or password', 'invalid_credentials');
    if (!u) {
      await bcrypt.compare(body.password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali'); // equalize timing
      throw invalid;
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw new AppError(423, 'Account temporarily locked after repeated failed sign-ins. Try again later.', 'locked');
    }
    const ok = await bcrypt.compare(body.password, u.password_hash);
    if (!ok || !u.is_active) {
      if (!ok) {
        const failed = u.failed_login_count + 1;
        const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
        await app.pool.query('UPDATE users SET failed_login_count = $2, locked_until = $3 WHERE id = $1', [
          u.id, lock ? 0 : failed, lock
        ]);
        await writeAudit(app.pool, { orgId: u.org_id, actorUserId: u.id, action: 'auth.login_failed', ip: req.ip });
      }
      throw invalid;
    }
    await app.pool.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
    await writeAudit(app.pool, { orgId: u.org_id, actorUserId: u.id, action: 'auth.login', ip: req.ip });
    return { user: publicUser(u), ...(await issueTokens(u.id)) };
  });

  app.post('/refresh', limit, async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const { rows } = await app.pool.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [hashToken(refreshToken)]);
    const t = rows[0];
    if (!t) throw unauthorized('Invalid refresh token');
    if (t.revoked_at) {
      // A rotated token was presented again: treat as theft and end all sessions of that user.
      await app.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [t.user_id]);
      throw unauthorized('Session revoked');
    }
    if (new Date(t.expires_at) < new Date()) throw unauthorized('Refresh token expired');
    const ur = await app.pool.query(
      `SELECT u.*, o.name AS org_name FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`, [t.user_id]
    );
    const u = ur.rows[0];
    if (!u || !u.is_active) throw unauthorized('Account is not active');
    const claimed = await app.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [t.id]);
    if (!claimed.rowCount) throw unauthorized('Session revoked');
    return { user: publicUser(u), ...(await issueTokens(u.id)) };
  });

  app.post('/logout', async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    await app.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
      hashToken(refreshToken)
    ]);
    return { ok: true };
  });

  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    const { rows } = await app.pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.org_id, o.name AS org_name
       FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`, [req.auth.userId]
    );
    return { user: publicUser(rows[0]) };
  });
}
