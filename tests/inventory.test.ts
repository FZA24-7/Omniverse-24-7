import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { createPool } from '../src/db';
import { runMigrations } from '../src/migrate';
import { buildApp } from '../src/app';

const DB = process.env.TEST_DATABASE_URL ?? 'postgresql://omniverse:omniverse_dev@127.0.0.1:5432/omniverse_test';
let app: FastifyInstance; let pool: Pool;
const PW = 'correct-horse-battery';
type Sess = { accessToken: string; user: { id: string; orgId: string } };

async function call(method: string, url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.json() as any };
}
async function register(org: string, email: string): Promise<Sess> {
  const r = await call('POST', '/api/auth/register-organization', undefined, { organizationName: org, fullName: org, email, password: PW });
  expect(r.status).toBe(201); return r.body;
}
async function addUser(owner: Sess, email: string, role: string): Promise<Sess> {
  expect((await call('POST', '/api/users', owner.accessToken, { email, fullName: email, password: PW, role })).status).toBe(201);
  return (await call('POST', '/api/auth/login', undefined, { email, password: PW })).body;
}
const mkBranch = async (s: Sess, code: string) => (await call('POST', '/api/branches', s.accessToken, { code, name: `Branch ${code}` })).body.branch;
const mkProduct = async (s: Sess, sku: string, extra: object = {}) => (await call('POST', '/api/products', s.accessToken, { sku, name: `Product ${sku}`, costCents: 500, ...extra })).body.product;
const level = async (s: Sess, branchId: string, productId: string) =>
  (await call('GET', `/api/inventory?branchId=${branchId}&productId=${productId}`, s.accessToken)).body.levels[0]?.quantity ?? 0;

beforeAll(async () => {
  pool = createPool(DB);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool, () => undefined);
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB, JWT_SECRET: 'y'.repeat(40), BCRYPT_ROUNDS: '4', AUTH_RATE_LIMIT_MAX: '1000' } as NodeJS.ProcessEnv);
  app = await buildApp({ pool, config });
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('branches & categories', () => {
  let o: Sess, emp: Sess, ro: Sess;
  beforeAll(async () => { o = await register('Inv Org', 'o@inv.test'); emp = await addUser(o, 'e@inv.test', 'employee'); ro = await addUser(o, 'r@inv.test', 'readonly'); });
  it('creates, updates and lists branches; codes are unique per org', async () => {
    const b = await mkBranch(o, 'MAIN'); expect(b.status).toBe('active');
    expect((await call('POST', '/api/branches', o.accessToken, { code: 'MAIN', name: 'dup' })).status).toBe(409);
    const up = await call('PATCH', `/api/branches/${b.id}`, o.accessToken, { name: 'Main Store', city: 'Karachi', status: 'inactive' });
    expect(up.body.branch).toMatchObject({ name: 'Main Store', city: 'Karachi', status: 'inactive' });
    const list = await call('GET', '/api/branches', ro.accessToken);
    expect(list.body.branches).toHaveLength(1);
  });
  it('only owners/managers manage branches and categories', async () => {
    expect((await call('POST', '/api/branches', emp.accessToken, { code: 'X', name: 'x' })).status).toBe(403);
    expect((await call('POST', '/api/categories', emp.accessToken, { name: 'x' })).status).toBe(403);
    expect((await call('POST', '/api/branches', ro.accessToken, { code: 'X', name: 'x' })).status).toBe(403);
  });
  it('categories are unique case-insensitively; deleting one uncategorizes products', async () => {
    const c = (await call('POST', '/api/categories', o.accessToken, { name: 'Drinks' })).body.category;
    expect((await call('POST', '/api/categories', o.accessToken, { name: 'drinks' })).status).toBe(409);
    const p = await mkProduct(o, 'COLA', { categoryId: c.id });
    expect(p.categoryName).toBe('Drinks');
    expect((await call('DELETE', `/api/categories/${c.id}`, o.accessToken)).status).toBe(200);
    expect((await call('GET', `/api/products/${p.id}`, o.accessToken)).body.product.categoryId).toBeNull();
  });
  it('products: search, category filter, pagination and category validation', async () => {
    const c = (await call('POST', '/api/categories', o.accessToken, { name: 'Snacks' })).body.category;
    await mkProduct(o, 'CHIPS-1', { categoryId: c.id }); await mkProduct(o, 'CHIPS-2', { categoryId: c.id }); await mkProduct(o, 'NUTS');
    expect((await call('GET', '/api/products?q=chips', o.accessToken)).body.total).toBe(2);
    expect((await call('GET', `/api/products?categoryId=${c.id}`, o.accessToken)).body.total).toBe(2);
    expect((await call('GET', '/api/products?q=%25', o.accessToken)).body.total).toBe(0);      // % is literal, not a wildcard
    expect((await call('GET', '/api/products?limit=1&offset=1', o.accessToken)).body.products).toHaveLength(1);
    expect((await call('POST', '/api/products', o.accessToken, { sku: 'BADCAT', name: 'x', categoryId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
  });
});

describe('stock operations', () => {
  let o: Sess, mgr: Sess, emp: Sess, ro: Sess, A: any, B: any, P: any;
  beforeAll(async () => {
    o = await register('Stock Org', 'o@stock.test'); mgr = await addUser(o, 'm@stock.test', 'manager');
    emp = await addUser(o, 'e@stock.test', 'employee'); ro = await addUser(o, 'r@stock.test', 'readonly');
    A = await mkBranch(o, 'A'); B = await mkBranch(o, 'B'); P = await mkProduct(o, 'WIDGET', { reorderLevel: 5 });
  });
  it('receipt increases stock and writes a ledger row with the balance', async () => {
    const r = await call('POST', '/api/inventory/receipts', emp.accessToken, { branchId: A.id, productId: P.id, quantity: 20, reference: 'PO-1' });
    expect(r.status).toBe(201);
    expect(r.body.movement).toMatchObject({ type: 'receipt', quantityDelta: 20, balanceAfter: 20, reference: 'PO-1' });
    expect(await level(o, A.id, P.id)).toBe(20);
    expect((await call('GET', `/api/products/${P.id}`, o.accessToken)).body.product.onHand).toBe(20);
  });
  it('idempotency key: replay returns the first result and does not double count', async () => {
    const key = 'receipt-key-0001';
    const a = await call('POST', '/api/inventory/receipts', o.accessToken, { branchId: A.id, productId: P.id, quantity: 5, idempotencyKey: key });
    const b = await call('POST', '/api/inventory/receipts', o.accessToken, { branchId: A.id, productId: P.id, quantity: 5, idempotencyKey: key });
    expect(a.status).toBe(201); expect(b.status).toBe(200); expect(b.body.replayed).toBe(true);
    expect(b.body.movement.id).toBe(a.body.movement.id);
    expect(await level(o, A.id, P.id)).toBe(25);
  });
  it('concurrent identical keys apply exactly once', async () => {
    const key = 'race-key-00000001';
    const rs = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/inventory/receipts', o.accessToken, { branchId: A.id, productId: P.id, quantity: 1, idempotencyKey: key })));
    expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await level(o, A.id, P.id)).toBe(26);
  });
  it('negative stock is refused and leaves everything unchanged', async () => {
    const before = (await call('GET', '/api/inventory/movements', o.accessToken)).body.total;
    const r = await call('POST', '/api/inventory/adjustments', mgr.accessToken, { branchId: A.id, productId: P.id, delta: -999, reason: 'shrinkage' });
    expect(r.status).toBe(409); expect(r.body.message).toMatch(/Insufficient stock/);
    expect(await level(o, A.id, P.id)).toBe(26);
    expect((await call('GET', '/api/inventory/movements', o.accessToken)).body.total).toBe(before);
  });
  it('parallel withdrawals can never drive stock below zero', async () => {
    const C = await mkBranch(o, 'C'); const Q = await mkProduct(o, 'RACE');
    await call('POST', '/api/inventory/receipts', o.accessToken, { branchId: C.id, productId: Q.id, quantity: 5 });
    const rs = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/api/inventory/adjustments', o.accessToken, { branchId: C.id, productId: Q.id, delta: -1, reason: 'sale correction' })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await level(o, C.id, Q.id)).toBe(0);
  });
  it('transfer moves stock atomically between branches', async () => {
    const t = await call('POST', '/api/inventory/transfers', mgr.accessToken, { fromBranchId: A.id, toBranchId: B.id, productId: P.id, quantity: 10, reason: 'rebalance' });
    expect(t.status).toBe(201);
    expect(t.body.out.quantityDelta).toBe(-10); expect(t.body.in.quantityDelta).toBe(10);
    expect(await level(o, A.id, P.id)).toBe(16); expect(await level(o, B.id, P.id)).toBe(10);
  });
  it('failed or invalid transfers change nothing', async () => {
    expect((await call('POST', '/api/inventory/transfers', mgr.accessToken, { fromBranchId: A.id, toBranchId: B.id, productId: P.id, quantity: 999 })).status).toBe(409);
    expect((await call('POST', '/api/inventory/transfers', mgr.accessToken, { fromBranchId: A.id, toBranchId: A.id, productId: P.id, quantity: 1 })).status).toBe(400);
    expect(await level(o, A.id, P.id)).toBe(16); expect(await level(o, B.id, P.id)).toBe(10);
  });
  it('opposite concurrent transfers do not deadlock and conserve total stock', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/api/inventory/transfers', mgr.accessToken,
      i % 2 ? { fromBranchId: A.id, toBranchId: B.id, productId: P.id, quantity: 1 } : { fromBranchId: B.id, toBranchId: A.id, productId: P.id, quantity: 1 })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect((await level(o, A.id, P.id)) + (await level(o, B.id, P.id))).toBe(26);
  });
  it('inactive branches cannot receive stock but existing stock can still leave', async () => {
    const D = await mkBranch(o, 'D'); await call('PATCH', `/api/branches/${D.id}`, o.accessToken, { status: 'inactive' });
    expect((await call('POST', '/api/inventory/receipts', o.accessToken, { branchId: D.id, productId: P.id, quantity: 1 })).status).toBe(409);
    expect((await call('POST', '/api/inventory/transfers', mgr.accessToken, { fromBranchId: A.id, toBranchId: D.id, productId: P.id, quantity: 1 })).status).toBe(409);
    expect(await level(o, A.id, P.id)).toBeGreaterThan(0);
  });
  it('physical count (correction) records the difference and is a no-op when equal', async () => {
    const cur = await level(o, B.id, P.id);
    const r = await call('POST', '/api/inventory/corrections', mgr.accessToken, { branchId: B.id, productId: P.id, countedQuantity: cur - 3, reason: 'stocktake' });
    expect(r.status).toBe(201); expect(r.body.movement).toMatchObject({ type: 'correction', quantityDelta: -3, balanceAfter: cur - 3 });
    const same = await call('POST', '/api/inventory/corrections', mgr.accessToken, { branchId: B.id, productId: P.id, countedQuantity: cur - 3, reason: 'stocktake again' });
    expect(same.status).toBe(200); expect(same.body.unchanged).toBe(true);
  });
  it('role checks: employees can receive but not adjust/transfer/count; read-only cannot write', async () => {
    const body = { branchId: A.id, productId: P.id };
    expect((await call('POST', '/api/inventory/adjustments', emp.accessToken, { ...body, delta: -1, reason: 'abc' })).status).toBe(403);
    expect((await call('POST', '/api/inventory/transfers', emp.accessToken, { fromBranchId: A.id, toBranchId: B.id, productId: P.id, quantity: 1 })).status).toBe(403);
    expect((await call('POST', '/api/inventory/corrections', emp.accessToken, { ...body, countedQuantity: 1, reason: 'abc' })).status).toBe(403);
    expect((await call('POST', '/api/inventory/receipts', ro.accessToken, { ...body, quantity: 1 })).status).toBe(403);
    expect((await call('GET', '/api/inventory', ro.accessToken)).status).toBe(200);
    expect((await call('GET', '/api/inventory/movements', ro.accessToken)).status).toBe(200);
  });
  it('rejects invalid input', async () => {
    const body = { branchId: A.id, productId: P.id };
    for (const bad of [{ ...body, quantity: 0 }, { ...body, quantity: 1.5 }, { ...body, quantity: 99_999_999 }, { ...body, quantity: -2 }, { branchId: 'nope', productId: P.id, quantity: 1 }])
      expect((await call('POST', '/api/inventory/receipts', o.accessToken, bad)).status).toBe(400);
    expect((await call('POST', '/api/inventory/adjustments', o.accessToken, { ...body, delta: 0, reason: 'zero' })).status).toBe(400);
    expect((await call('POST', '/api/inventory/adjustments', o.accessToken, { ...body, delta: 1 })).status).toBe(400); // reason required
  });
  it('products with stock history cannot be deleted', async () => {
    const r = await call('DELETE', `/api/products/${P.id}`, o.accessToken);
    expect(r.status).toBe(409);
    expect((await call('PATCH', `/api/products/${P.id}`, o.accessToken, { isActive: false })).body.product.isActive).toBe(false);
  });
  it('ledger integrity: every balance equals the sum of its movements, and balance_after is consistent', async () => {
    const bad = await pool.query(`SELECT l.branch_id, l.product_id, l.quantity, COALESCE(sum(m.quantity_delta),0)::int AS ledger
      FROM inventory_levels l LEFT JOIN stock_movements m ON m.branch_id = l.branch_id AND m.product_id = l.product_id
      GROUP BY l.branch_id, l.product_id, l.quantity HAVING l.quantity <> COALESCE(sum(m.quantity_delta),0)`);
    expect(bad.rows).toEqual([]);
    const neg = await pool.query('SELECT count(*)::int AS n FROM inventory_levels WHERE quantity < 0');
    expect(neg.rows[0].n).toBe(0);
    const chain = await pool.query(`SELECT count(*)::int AS n FROM (
      SELECT balance_after - quantity_delta - COALESCE(lag(balance_after) OVER (PARTITION BY branch_id, product_id ORDER BY seq), 0) AS diff
      FROM stock_movements) x WHERE diff <> 0`);
    expect(chain.rows[0].n).toBe(0);
  });
});

describe('alerts, thresholds, analytics, dashboard', () => {
  let o: Sess, A: any, P: any, Q: any, R: any;
  beforeAll(async () => {
    o = await register('Alert Org', 'o@alert.test'); A = await mkBranch(o, 'A');
    P = await mkProduct(o, 'LOW-1', { reorderLevel: 10 }); Q = await mkProduct(o, 'OK-1', { reorderLevel: 2 }); R = await mkProduct(o, 'ZERO-1', { reorderLevel: 3 });
    const cat = (await call('POST', '/api/categories', o.accessToken, { name: 'Gear' })).body.category;
    await call('PATCH', `/api/products/${P.id}`, o.accessToken, { categoryId: cat.id });
    for (const [pr, n] of [[P, 8], [Q, 50], [R, 4]] as const) await call('POST', '/api/inventory/receipts', o.accessToken, { branchId: A.id, productId: pr.id, quantity: n });
    await call('POST', '/api/inventory/adjustments', o.accessToken, { branchId: A.id, productId: R.id, delta: -4, reason: 'sold out' });
  });
  it('classifies ok / low / out and filters by status', async () => {
    const all = (await call('GET', '/api/inventory', o.accessToken)).body.levels;
    const by = Object.fromEntries(all.map((l: any) => [l.sku, l.status]));
    expect(by).toEqual({ 'LOW-1': 'low', 'OK-1': 'ok', 'ZERO-1': 'out' });
    expect((await call('GET', '/api/inventory?status=low', o.accessToken)).body.total).toBe(1);
    expect((await call('GET', '/api/inventory?q=ok-', o.accessToken)).body.total).toBe(1);
  });
  it('alerts list out-of-stock first', async () => {
    const a = (await call('GET', '/api/inventory/alerts', o.accessToken)).body;
    expect(a.outCount).toBe(1); expect(a.lowCount).toBe(1); expect(a.alerts[0].sku).toBe('ZERO-1');
  });
  it('per-branch threshold override changes the status; null restores the product default', async () => {
    let r = await call('PATCH', '/api/inventory/threshold', o.accessToken, { branchId: A.id, productId: Q.id, lowStockThreshold: 60 });
    expect(r.body.level.status).toBe('low');
    r = await call('PATCH', '/api/inventory/threshold', o.accessToken, { branchId: A.id, productId: Q.id, lowStockThreshold: null });
    expect(r.body.level.status).toBe('ok');
  });
  it('analytics and dashboard are computed from real rows, per currency', async () => {
    const an = (await call('GET', '/api/inventory/analytics', o.accessToken)).body;
    expect(an.dataSource).toBe('live');
    expect(an.byBranch[0]).toMatchObject({ units: 58, skus: 2 });             // 8 + 50 + 0
    expect(an.byBranch[0].valueAtCost).toEqual([{ currency: 'USD', cents: 58 * 500 }]);
    expect(an.statusCounts).toEqual({ ok: 1, low: 1, out: 1 });
    expect(an.byCategory.find((c: any) => c.category === 'Gear').units).toBe(8);
    const rec = an.movements30d.find((m: any) => m.type === 'receipt');
    expect(rec).toMatchObject({ count: 3, unitsIn: 62 });
    const d = (await call('GET', '/api/dashboard', o.accessToken)).body;
    expect(d.inventory).toMatchObject({ totalUnits: 58, lowStockCount: 1, outOfStockCount: 1 });
    expect(d.inventory.valueAtCost).toEqual([{ currency: 'USD', cents: 29000 }]);
  });
  it('does not add value across currencies', async () => {
    const E = await mkProduct(o, 'EUR-1', { currency: 'EUR', costCents: 100 });
    await call('POST', '/api/inventory/receipts', o.accessToken, { branchId: A.id, productId: E.id, quantity: 10 });
    const d = (await call('GET', '/api/dashboard', o.accessToken)).body;
    expect(d.inventory.valueAtCost).toEqual(expect.arrayContaining([{ currency: 'USD', cents: 29000 }, { currency: 'EUR', cents: 1000 }]));
  });
  it('movement history supports filters and pagination, and audit records stock actions', async () => {
    const m = (await call('GET', `/api/inventory/movements?productId=${R.id}`, o.accessToken)).body;
    expect(m.total).toBe(2); expect(m.movements[0].type).toBe('adjustment'); expect(m.movements[0].productName).toBeTruthy();
    expect((await call('GET', '/api/inventory/movements?type=receipt&limit=1', o.accessToken)).body.movements).toHaveLength(1);
    expect((await call('GET', '/api/inventory/movements?from=not-a-date', o.accessToken)).status).toBe(400);
    const actions = (await call('GET', '/api/audit?limit=200', o.accessToken)).body.entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['inventory.receipt', 'inventory.adjustment', 'inventory.threshold', 'branch.created']));
  });
});

describe('tenant isolation for inventory', () => {
  let a: Sess, b: Sess, aBranch: any, aProd: any, bBranch: any, bProd: any;
  beforeAll(async () => {
    a = await register('Iso A', 'a@iso.test'); b = await register('Iso B', 'b@iso.test');
    aBranch = await mkBranch(a, 'A1'); aProd = await mkProduct(a, 'SKU'); bBranch = await mkBranch(b, 'B1'); bProd = await mkProduct(b, 'SKU');
    await call('POST', '/api/inventory/receipts', a.accessToken, { branchId: aBranch.id, productId: aProd.id, quantity: 7 });
  });
  it("B cannot see A's stock, movements, alerts, branches or analytics", async () => {
    expect((await call('GET', '/api/inventory', b.accessToken)).body.total).toBe(0);
    expect((await call('GET', '/api/inventory/movements', b.accessToken)).body.total).toBe(0);
    expect((await call('GET', '/api/branches', b.accessToken)).body.branches.map((x: any) => x.id)).toEqual([bBranch.id]);
    expect((await call('GET', '/api/inventory/analytics', b.accessToken)).body.byBranch).toEqual([]);
    expect((await call('GET', `/api/inventory?branchId=${aBranch.id}`, b.accessToken)).body.total).toBe(0);
  });
  it("B cannot move stock using A's branch or product ids (any combination)", async () => {
    const ops: [string, any][] = [
      ['receipts', { branchId: aBranch.id, productId: bProd.id, quantity: 1 }], ['receipts', { branchId: bBranch.id, productId: aProd.id, quantity: 1 }],
      ['adjustments', { branchId: aBranch.id, productId: aProd.id, delta: -1, reason: 'steal' }],
      ['corrections', { branchId: aBranch.id, productId: aProd.id, countedQuantity: 0, reason: 'steal' }],
      ['transfers', { fromBranchId: aBranch.id, toBranchId: bBranch.id, productId: aProd.id, quantity: 1 }],
      ['transfers', { fromBranchId: bBranch.id, toBranchId: aBranch.id, productId: bProd.id, quantity: 1 }]
    ];
    for (const [path, body] of ops) expect([403, 404]).toContain((await call('POST', `/api/inventory/${path}`, b.accessToken, body)).status);
    expect((await call('PATCH', `/api/branches/${aBranch.id}`, b.accessToken, { status: 'inactive' })).status).toBe(404);
    expect(await level(a, aBranch.id, aProd.id)).toBe(7);
  });
  it('the database itself rejects cross-tenant stock rows (composite foreign keys)', async () => {
    await expect(pool.query('INSERT INTO inventory_levels (org_id, branch_id, product_id, quantity) VALUES ($1,$2,$3,1)', [b.user.orgId, aBranch.id, bProd.id])).rejects.toThrow();
    await expect(pool.query('UPDATE products SET category_id = gen_random_uuid() WHERE id = $1', [aProd.id])).rejects.toThrow();
  });
  it("idempotency keys are scoped per organization", async () => {
    const key = 'shared-key-00001';
    expect((await call('POST', '/api/inventory/receipts', a.accessToken, { branchId: aBranch.id, productId: aProd.id, quantity: 1, idempotencyKey: key })).status).toBe(201);
    const r = await call('POST', '/api/inventory/receipts', b.accessToken, { branchId: bBranch.id, productId: bProd.id, quantity: 1, idempotencyKey: key });
    expect(r.status).toBe(201); expect(await level(b, bBranch.id, bProd.id)).toBe(1);
  });
});
