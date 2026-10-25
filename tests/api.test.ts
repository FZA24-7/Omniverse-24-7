import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { createPool } from '../src/db';
import { runMigrations } from '../src/migrate';
import { buildApp } from '../src/app';

const DB = process.env.TEST_DATABASE_URL ?? 'postgresql://omniverse:omniverse_dev@127.0.0.1:5432/omniverse_test';
let app: FastifyInstance;
let pool: Pool;

const PW = 'correct-horse-battery';
type Sess = { accessToken: string; refreshToken: string; user: { id: string; orgId: string } };

async function call(method: string, url: string, token?: string, payload?: unknown) {
  const res = await app.inject({
    method: method as 'GET', url, payload: payload as object | undefined,
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  return { status: res.statusCode, body: res.json() as any };
}
async function register(org: string, email: string): Promise<Sess> {
  const r = await call('POST', '/api/auth/register-organization', undefined, {
    organizationName: org, fullName: `Owner ${org}`, email, password: PW
  });
  expect(r.status).toBe(201);
  return r.body;
}
async function addUser(owner: Sess, email: string, role: string): Promise<Sess> {
  const c = await call('POST', '/api/users', owner.accessToken, { email, fullName: email, password: PW, role });
  expect(c.status).toBe(201);
  const l = await call('POST', '/api/auth/login', undefined, { email, password: PW });
  expect(l.status).toBe(200);
  return l.body;
}

beforeAll(async () => {
  pool = createPool(DB);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool, () => undefined);
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: DB, JWT_SECRET: 'x'.repeat(40), BCRYPT_ROUNDS: '4', AUTH_RATE_LIMIT_MAX: '1000'
  } as NodeJS.ProcessEnv);
  app = await buildApp({ pool, config });
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('health & config', () => {
  it('reports healthy with database up', async () => {
    const r = await call('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body.database).toBe('up');
  });
  it('rejects short JWT secret and missing database url', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ JWT_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });
  it('refuses placeholder secrets in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', JWT_SECRET: 'CHANGE_ME_' + 'a'.repeat(30) } as NodeJS.ProcessEnv)).toThrow(/placeholder/);
  });
  it('migrations are idempotent', async () => {
    expect(await runMigrations(pool, () => undefined)).toEqual([]);
  });
});

describe('authentication', () => {
  it('registers an organization and returns an owner session', async () => {
    const s = await register('Acme Retail', 'owner@acme.test');
    expect(s.accessToken).toBeTruthy();
    const me = await call('GET', '/api/auth/me', s.accessToken);
    expect(me.body.user.role).toBe('owner');
    expect(me.body.user.orgName).toBe('Acme Retail');
  });
  it('rejects weak passwords, bad email and duplicate email', async () => {
    const weak = await call('POST', '/api/auth/register-organization', undefined, { organizationName: 'Zed', fullName: 'Z', email: 'z@z.test', password: 'short' });
    expect(weak.status).toBe(400);
    const bad = await call('POST', '/api/auth/register-organization', undefined, { organizationName: 'Zed', fullName: 'Z', email: 'nope', password: PW });
    expect(bad.status).toBe(400);
    const dup = await call('POST', '/api/auth/register-organization', undefined, { organizationName: 'Other', fullName: 'Z', email: 'OWNER@acme.test', password: PW });
    expect(dup.status).toBe(409);
  });
  it('requires authentication and rejects tampered tokens', async () => {
    expect((await call('GET', '/api/leads')).status).toBe(401);
    const s = await register('Tamper Co', 'tamper@t.test');
    expect((await call('GET', '/api/leads', s.accessToken.slice(0, -3) + 'abc')).status).toBe(401);
  });
  it('rejects wrong password with a generic message and locks after repeated failures', async () => {
    await register('Lock Co', 'lock@l.test');
    const first = await call('POST', '/api/auth/login', undefined, { email: 'lock@l.test', password: 'wrong-password-1' });
    expect(first.status).toBe(401);
    expect(first.body.error).toBe('invalid_credentials');
    for (let i = 0; i < 4; i++) await call('POST', '/api/auth/login', undefined, { email: 'lock@l.test', password: 'wrong-password-1' });
    const locked = await call('POST', '/api/auth/login', undefined, { email: 'lock@l.test', password: PW });
    expect(locked.status).toBe(423);
  });
  it('rotates refresh tokens and revokes all sessions when an old one is reused', async () => {
    const s = await register('Rotate Co', 'rot@r.test');
    const r1 = await call('POST', '/api/auth/refresh', undefined, { refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    const reuse = await call('POST', '/api/auth/refresh', undefined, { refreshToken: s.refreshToken });
    expect(reuse.status).toBe(401);
    const afterTheft = await call('POST', '/api/auth/refresh', undefined, { refreshToken: r1.body.refreshToken });
    expect(afterTheft.status).toBe(401);
  });
  it('logout revokes the refresh token', async () => {
    const s = await register('Logout Co', 'out@o.test');
    await call('POST', '/api/auth/logout', s.accessToken, { refreshToken: s.refreshToken });
    expect((await call('POST', '/api/auth/refresh', undefined, { refreshToken: s.refreshToken })).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  let a: Sess, b: Sess, leadId: string, productId: string;
  beforeAll(async () => {
    a = await register('Tenant A', 'a@tenant.test');
    b = await register('Tenant B', 'b@tenant.test');
    leadId = (await call('POST', '/api/leads', a.accessToken, { name: 'Secret Lead A', valueCents: 5000 })).body.lead.id;
    productId = (await call('POST', '/api/products', a.accessToken, { sku: 'SKU-1', name: 'Widget A' })).body.product.id;
  });
  it("tenant B cannot read, list, update or delete tenant A's lead", async () => {
    expect((await call('GET', `/api/leads/${leadId}`, b.accessToken)).status).toBe(404);
    expect((await call('PATCH', `/api/leads/${leadId}`, b.accessToken, { name: 'hacked' })).status).toBe(404);
    expect((await call('DELETE', `/api/leads/${leadId}`, b.accessToken)).status).toBe(404);
    const list = await call('GET', '/api/leads', b.accessToken);
    expect(list.body.leads).toHaveLength(0);
    const still = await call('GET', `/api/leads/${leadId}`, a.accessToken);
    expect(still.body.lead.name).toBe('Secret Lead A');
  });
  it("tenant B cannot touch tenant A's products and may reuse the same SKU", async () => {
    expect((await call('PATCH', `/api/products/${productId}`, b.accessToken, { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/api/products/${productId}`, b.accessToken)).status).toBe(404);
    expect((await call('POST', '/api/products', b.accessToken, { sku: 'SKU-1', name: 'Widget B' })).status).toBe(201);
  });
  it("owner of B cannot modify or list users of A; audit and dashboard are scoped", async () => {
    expect((await call('PATCH', `/api/users/${a.user.id}`, b.accessToken, { isActive: false })).status).toBe(404);
    const users = await call('GET', '/api/users', b.accessToken);
    expect(users.body.users.every((u: any) => u.email.startsWith('b@'))).toBe(true);
    const audit = await call('GET', '/api/audit', b.accessToken);
    expect(audit.body.entries.some((e: any) => e.action === 'lead.created')).toBe(false);
    const dash = await call('GET', '/api/dashboard', b.accessToken);
    expect(dash.body.leads.openCount).toBe(0);
  });
  it('a client-supplied org id in the body is ignored', async () => {
    const r = await call('POST', '/api/leads', b.accessToken, { name: 'Sneaky', org_id: a.user.orgId, orgId: a.user.orgId });
    expect(r.status).toBe(201);
    const aList = await call('GET', '/api/leads', a.accessToken);
    expect(aList.body.leads.some((l: any) => l.name === 'Sneaky')).toBe(false);
  });
});

describe('role-based access control', () => {
  let owner: Sess, manager: Sess, employee: Sess, readonly: Sess;
  beforeAll(async () => {
    owner = await register('Roles Co', 'owner@roles.test');
    manager = await addUser(owner, 'manager@roles.test', 'manager');
    employee = await addUser(owner, 'employee@roles.test', 'employee');
    readonly = await addUser(owner, 'readonly@roles.test', 'readonly');
  });
  it('read-only users can read but not write', async () => {
    expect((await call('GET', '/api/leads', readonly.accessToken)).status).toBe(200);
    expect((await call('POST', '/api/leads', readonly.accessToken, { name: 'x' })).status).toBe(403);
    expect((await call('POST', '/api/products', readonly.accessToken, { sku: 'a', name: 'a' })).status).toBe(403);
  });
  it('employees can create leads but cannot delete them or manage products', async () => {
    const created = await call('POST', '/api/leads', employee.accessToken, { name: 'Emp lead' });
    expect(created.status).toBe(201);
    expect((await call('DELETE', `/api/leads/${created.body.lead.id}`, employee.accessToken)).status).toBe(403);
    expect((await call('POST', '/api/products', employee.accessToken, { sku: 'e', name: 'e' })).status).toBe(403);
    expect((await call('DELETE', `/api/leads/${created.body.lead.id}`, manager.accessToken)).status).toBe(200);
  });
  it('only owners manage users; employees cannot see the audit log or user list', async () => {
    expect((await call('POST', '/api/users', manager.accessToken, { email: 'x@roles.test', fullName: 'x', password: PW, role: 'employee' })).status).toBe(403);
    expect((await call('GET', '/api/users', employee.accessToken)).status).toBe(403);
    expect((await call('GET', '/api/audit', employee.accessToken)).status).toBe(403);
    expect((await call('GET', '/api/audit', manager.accessToken)).status).toBe(200);
  });
  it('cannot create a platform_admin through the API', async () => {
    const r = await call('POST', '/api/users', owner.accessToken, { email: 'pa@roles.test', fullName: 'x', password: PW, role: 'platform_admin' });
    expect(r.status).toBe(400);
  });
  it('owners cannot demote or deactivate themselves', async () => {
    expect((await call('PATCH', `/api/users/${owner.user.id}`, owner.accessToken, { isActive: false })).status).toBe(403);
    expect((await call('PATCH', `/api/users/${owner.user.id}`, owner.accessToken, { role: 'readonly' })).status).toBe(403);
  });
  it('deactivating a user invalidates their existing token immediately', async () => {
    expect((await call('GET', '/api/leads', employee.accessToken)).status).toBe(200);
    expect((await call('PATCH', `/api/users/${employee.user.id}`, owner.accessToken, { isActive: false })).status).toBe(200);
    expect((await call('GET', '/api/leads', employee.accessToken)).status).toBe(401);
    expect((await call('POST', '/api/auth/refresh', undefined, { refreshToken: employee.refreshToken })).status).toBe(401);
  });
  it('role changes take effect on the next request', async () => {
    expect((await call('POST', '/api/leads', manager.accessToken, { name: 'm' })).status).toBe(201);
    await call('PATCH', `/api/users/${manager.user.id}`, owner.accessToken, { role: 'readonly' });
    expect((await call('POST', '/api/leads', manager.accessToken, { name: 'm2' })).status).toBe(403);
  });
});

describe('CRM, retail and dashboard behaviour', () => {
  let s: Sess;
  beforeAll(async () => { s = await register('Data Co', 'owner@data.test'); });
  it('creates, filters, updates and paginates leads', async () => {
    for (const [name, stage, v] of [['L1', 'new', 1000], ['L2', 'qualified', 2500], ['L3', 'won', 9000]] as const) {
      expect((await call('POST', '/api/leads', s.accessToken, { name, stage, valueCents: v })).status).toBe(201);
    }
    const q = await call('GET', '/api/leads?stage=qualified', s.accessToken);
    expect(q.body.total).toBe(1);
    const page = await call('GET', '/api/leads?limit=2&offset=0', s.accessToken);
    expect(page.body.leads).toHaveLength(2);
    expect(page.body.total).toBe(3);
    const id = q.body.leads[0].id;
    const up = await call('PATCH', `/api/leads/${id}`, s.accessToken, { stage: 'proposal' });
    expect(up.body.lead.stage).toBe('proposal');
  });
  it('validates lead input', async () => {
    expect((await call('POST', '/api/leads', s.accessToken, { name: '' })).status).toBe(400);
    expect((await call('POST', '/api/leads', s.accessToken, { name: 'x', stage: 'bogus' })).status).toBe(400);
    expect((await call('POST', '/api/leads', s.accessToken, { name: 'x', valueCents: -5 })).status).toBe(400);
    expect((await call('GET', '/api/leads/not-a-uuid', s.accessToken)).status).toBe(400);
    expect((await call('GET', '/api/leads?limit=9999', s.accessToken)).status).toBe(400);
  });
  it('enforces unique SKUs per organization', async () => {
    expect((await call('POST', '/api/products', s.accessToken, { sku: 'DUP', name: 'one' })).status).toBe(201);
    const dup = await call('POST', '/api/products', s.accessToken, { sku: 'DUP', name: 'two' });
    expect(dup.status).toBe(409);
  });
  it('dashboard figures are calculated from real rows', async () => {
    const d = (await call('GET', '/api/dashboard', s.accessToken)).body;
    expect(d.dataSource).toBe('live');
    expect(d.leads.openCount).toBe(2);                 // L1 new + L2 now proposal
    expect(d.leads.openPipeline).toEqual([{ currency: 'USD', cents: 3500 }]);
    expect(d.leads.wonValue).toEqual([{ currency: 'USD', cents: 9000 }]);
    expect(d.products.total).toBe(1);
    expect(d.unavailable).toContain('revenue');
    expect(d.recentActivity.length).toBeGreaterThan(0);
  });
  it('never adds money across different currencies', async () => {
    await call('POST', '/api/leads', s.accessToken, { name: 'Euro deal', valueCents: 7000, currency: 'eur' });
    const d = (await call('GET', '/api/dashboard', s.accessToken)).body;
    expect(d.leads.openPipeline).toEqual(expect.arrayContaining([
      { currency: 'USD', cents: 3500 }, { currency: 'EUR', cents: 7000 }
    ]));
    expect(d.leads.openPipeline).toHaveLength(2);
    await call('DELETE', `/api/leads/${(await call('GET', '/api/leads?stage=new&limit=50', s.accessToken)).body.leads.find((l: any) => l.name === 'Euro deal').id}`, s.accessToken);
  });
  it('writes audit entries for mutations', async () => {
    const a = await call('GET', '/api/audit', s.accessToken);
    const actions = a.body.entries.map((e: any) => e.action);
    expect(actions).toContain('organization.created');
    expect(actions).toContain('lead.created');
    expect(actions).toContain('product.created');
  });
  it('returns JSON 404 for unknown routes and never leaks internals', async () => {
    const r = await call('GET', '/api/nope', s.accessToken);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });
});
