import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { ZodError } from 'zod';
import type { Pool } from 'pg';
import type { Config } from './config';
import { AppError } from './errors';
import { registerAuth } from './auth';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { leadRoutes } from './routes/leads';
import { productRoutes } from './routes/products';
import { dashboardRoutes } from './routes/dashboard';
import { auditRoutes } from './routes/audit';
import { branchRoutes } from './routes/branches';
import { categoryRoutes } from './routes/categories';
import { inventoryRoutes } from './routes/inventory';

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    cfg: Config;
  }
}

export async function buildApp(opts: { pool: Pool; config: Config; logger?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000, trustProxy: false });
  app.decorate('pool', opts.pool);
  app.decorate('cfg', opts.config);

  await app.register(helmet);
  const origins = opts.config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, { origin: origins.length ? origins : false });
  await app.register(rateLimit, { global: false });
  await app.register(jwt, { secret: opts.config.JWT_SECRET, sign: { algorithm: 'HS256' }, verify: { algorithms: ['HS256'] } });
  registerAuth(app);

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Invalid input',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'internal_error', message: 'Unexpected server error' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Route not found' }));

  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(leadRoutes, { prefix: '/api/leads' });
  await app.register(productRoutes, { prefix: '/api/products' });
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' });
  await app.register(auditRoutes, { prefix: '/api/audit' });
  await app.register(branchRoutes, { prefix: '/api/branches' });
  await app.register(categoryRoutes, { prefix: '/api/categories' });
  await app.register(inventoryRoutes, { prefix: '/api/inventory' });
  return app;
}
