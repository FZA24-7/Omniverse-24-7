import type { FastifyInstance } from 'fastify';

/**
 * Every number here is calculated live from this organization's rows.
 * Revenue/expenses are intentionally NOT reported yet: there is no orders or
 * ledger module, and the API will not invent figures.
 */
export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (req) => {
    const org = req.auth.orgId;
    const [stages, products, team, recent, inv] = await Promise.all([
      app.pool.query(
        `SELECT stage, trim(currency) AS currency, count(*)::int AS count, COALESCE(sum(value_cents),0)::bigint AS value_cents
         FROM leads WHERE org_id = $1 GROUP BY stage, trim(currency)`, [org]),
      app.pool.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_active)::int AS active FROM products WHERE org_id = $1`, [org]),
      app.pool.query(`SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND is_active`, [org]),
      app.pool.query(
        `SELECT a.id, a.action, a.entity_type, a.created_at, u.full_name AS actor
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.org_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 8`, [org]),
      app.pool.query(
        `SELECT trim(p.currency) AS currency, COALESCE(sum(l.quantity),0)::int AS units,
                COALESCE(sum(l.quantity::bigint * p.cost_cents),0)::bigint AS value_cents,
                count(*) FILTER (WHERE l.quantity = 0)::int AS out_n,
                count(*) FILTER (WHERE l.quantity > 0 AND COALESCE(l.low_stock_threshold, p.reorder_level) > 0
                                  AND l.quantity <= COALESCE(l.low_stock_threshold, p.reorder_level))::int AS low_n,
                count(*)::int AS rows
         FROM inventory_levels l JOIN products p ON p.id = l.product_id AND p.org_id = l.org_id
         WHERE l.org_id = $1 GROUP BY trim(p.currency)`, [org])
    ]);
    const STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
    const OPEN = ['new', 'contacted', 'qualified', 'proposal'];
    const byStage: Record<string, { count: number }> = {};
    for (const st of STAGES) byStage[st] = { count: 0 };
    // Money is never summed across currencies: totals are reported per currency.
    const open: Record<string, number> = {};
    const won: Record<string, number> = {};
    for (const r of stages.rows) {
      byStage[r.stage].count += r.count;
      if (OPEN.includes(r.stage)) open[r.currency] = (open[r.currency] ?? 0) + r.value_cents;
      if (r.stage === 'won') won[r.currency] = (won[r.currency] ?? 0) + r.value_cents;
    }
    const toList = (m: Record<string, number>) =>
      Object.entries(m).map(([currency, cents]) => ({ currency, cents })).sort((a, b) => b.cents - a.cents);
    return {
      generatedAt: new Date().toISOString(),
      dataSource: 'live',
      leads: {
        byStage,
        openCount: OPEN.reduce((n, st) => n + byStage[st].count, 0),
        openPipeline: toList(open),
        wonValue: toList(won)
      },
      inventory: {
        totalUnits: inv.rows.reduce((n, r) => n + r.units, 0),
        stockRows: inv.rows.reduce((n, r) => n + r.rows, 0),
        lowStockCount: inv.rows.reduce((n, r) => n + r.low_n, 0),
        outOfStockCount: inv.rows.reduce((n, r) => n + r.out_n, 0),
        valueAtCost: inv.rows.map((r) => ({ currency: r.currency, cents: r.value_cents })).sort((a, b) => b.cents - a.cents)
      },
      products: { total: products.rows[0].total, active: products.rows[0].active },
      team: { activeUsers: team.rows[0].n },
      recentActivity: recent.rows.map((r) => ({
        id: r.id, action: r.action, entityType: r.entity_type, actor: r.actor, createdAt: r.created_at
      })),
      unavailable: ['revenue', 'expenses', 'marketing']
    };
  });
}
