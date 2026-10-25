import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    try {
      await app.pool.query('SELECT 1');
      return { status: 'ok', database: 'up', version: '0.1.0' };
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'down', version: '0.1.0' });
    }
  });
}
