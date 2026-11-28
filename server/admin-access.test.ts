import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Security tests for the CEO-only area (/api/admin): reports, Excel export, backups and restore.
 * Runs the real API router against a throwaway database.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-admin-test-'));
process.env.DATA_DIR = tmp;
delete process.env.CEO_INITIAL_PIN;
delete process.env.SUPABASE_URL;

const CEO_PIN = '48291736';
const STAFF_PIN = '735164';
const NON_CEO_ROLES = ['sales_1', 'sales_2', 'sales_3', 'sales_4', 'sales_mgr', 'accounting', 'warehouse_sup', 'driver'];

let server: Server;
let base = '';
const tokens: Record<string, string> = {};

async function call(method: string, url: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetch(base + url, { method, headers, body: payload });
}

before(async () => {
  const express = (await import('express')).default;
  const { createApiRouter } = await import('./routes');
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  const boot = await call('POST', '/auth/bootstrap', undefined, { ceoPin: CEO_PIN, staffInitialPin: STAFF_PIN });
  assert.equal(boot.status, 201);
  tokens.ceo = (await boot.json()).token;
  for (const role of NON_CEO_ROLES) {
    const r = await call('POST', '/auth/login', undefined, { roleId: role, pin: STAFF_PIN });
    assert.equal(r.status, 200, `login ${role}`);
    tokens[role] = (await r.json()).token;
  }
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ADMIN_GETS = [
  '/admin/reports/summary',
  '/admin/reports/summary?from=2020-01-01&to=2030-01-01',
  '/admin/reports/export.xlsx',
  '/admin/backups',
  '/admin/backups/full',
  '/admin/backups/stored/auto-2026-01-01.zip',
];

test('every non-CEO role is refused (403) on every admin endpoint', async () => {
  for (const role of NON_CEO_ROLES) {
    for (const url of ADMIN_GETS) {
      const res = await call('GET', url, tokens[role]);
      assert.equal(res.status, 403, `${role} GET ${url} should be 403, got ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes('PK'), 'no zip content leaked');
    }
    const fd = new FormData();
    fd.append('pin', STAFF_PIN);
    fd.append('backup', new Blob([Buffer.from('PK')]), 'x.zip');
    const res = await call('POST', '/admin/backups/restore', tokens[role], fd);
    assert.equal(res.status, 403, `${role} restore should be 403`);
  }
});

test('anonymous requests are refused (401) on every admin endpoint', async () => {
  for (const url of ADMIN_GETS) {
    const res = await call('GET', url);
    assert.equal(res.status, 401, `anonymous GET ${url}`);
  }
  const res = await call('POST', '/admin/backups/restore', undefined, new FormData());
  assert.equal(res.status, 401);
});

test('a forged token is refused', async () => {
  const res = await call('GET', '/admin/reports/summary', 'not-a-real-token');
  assert.equal(res.status, 401);
});

test('CEO can read reports, export Excel and download a full backup', async () => {
  const s = await call('GET', '/admin/reports/summary', tokens.ceo);
  assert.equal(s.status, 200);
  const { report } = await s.json();
  assert.equal(typeof report.orders.created, 'number');

  const x = await call('GET', '/admin/reports/export.xlsx', tokens.ceo);
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-type') || '', /spreadsheetml/);
  const xbuf = Buffer.from(await x.arrayBuffer());
  assert.equal(xbuf.subarray(0, 2).toString(), 'PK');

  const b = await call('GET', '/admin/backups/full', tokens.ceo);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('content-type'), 'application/zip');
});

/** Sends the path byte-for-byte (fetch would normalise "..", "%2E%2E" etc. before sending). */
async function rawGet(rawPath: string, token: string): Promise<{ status: number; body: string }> {
  const http = await import('node:http');
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: rawPath, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('path traversal in stored backup names is refused', async () => {
  // Plant a file next to the backups folder that a traversal would try to reach.
  fs.writeFileSync(path.join(tmp, 'secret.zip'), 'SECRET');
  const attempts = [
    '/api/admin/backups/stored/..%2F..%2Fautoparts_erp.sqlite',
    '/api/admin/backups/stored/auto-..%2F..%2Fsecret.zip',
    '/api/admin/backups/stored/..%2Fsecret.zip',
    '/api/admin/backups/stored/%2E%2E%2Fsecret.zip',
    '/api/admin/backups/stored/autoparts_erp.sqlite',
    '/api/admin/backups/stored/auto-x.zip%00.sqlite',
    '/api/admin/backups/stored/auto-%2E%2E%5Csecret.zip',
  ];
  for (const p of attempts) {
    const res = await rawGet(p, tokens.ceo);
    assert.ok(!res.body.includes('SECRET') && !res.body.includes('SQLite format'), `${p} leaked content`);
    assert.notEqual(res.status, 200, `${p} -> ${res.status}`);
  }
});

test('admin audit entries are visible to the CEO only', async () => {
  for (const role of ['accounting', 'warehouse_sup']) {
    const res = await call('GET', '/logs?limit=100', tokens[role]);
    const { items } = await res.json();
    assert.ok(items.every((i: { category: string }) => i.category !== 'admin'), `${role} must not see admin logs`);
  }
  const res = await call('GET', '/logs?limit=100', tokens.ceo);
  const { items } = await res.json();
  assert.ok(items.some((i: { category: string }) => i.category === 'admin'));
});

test('backup -> change -> restore brings back the exact earlier state', async () => {
  // Create an order with an uploaded file.
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const up = new FormData();
  up.append('kind', 'order_doc');
  up.append('file', new Blob([pdf], { type: 'application/pdf' }), 'invoice-1001.pdf');
  const upRes = await call('POST', '/files', tokens.sales_1, up);
  assert.equal(upRes.status, 201, await upRes.clone().text());
  const { fileId } = await upRes.json();
  const created = await call('POST', '/orders', tokens.sales_1, {
    customer: 'مشتری اول',
    proforma: '1001',
    amountToman: '1000000',
    items: 'قطعه',
    fileId,
  });
  assert.equal(created.status, 201);

  // Take a backup.
  const b = await call('GET', '/admin/backups/full', tokens.ceo);
  assert.equal(b.status, 200);
  const zip = Buffer.from(await b.arrayBuffer());

  // Change things after the backup.
  const later = await call('POST', '/orders', tokens.sales_1, {
    customer: 'مشتری دوم',
    proforma: '1002',
    amountToman: '2000000',
    items: 'قطعه',
  });
  assert.equal(later.status, 201);

  // Wrong PIN is refused and changes nothing.
  const bad = new FormData();
  bad.append('pin', '11112222');
  bad.append('backup', new Blob([zip]), 'b.zip');
  assert.equal((await call('POST', '/admin/backups/restore', tokens.ceo, bad)).status, 403);

  // A non-backup ZIP is refused.
  const junk = new FormData();
  junk.append('pin', CEO_PIN);
  junk.append('backup', new Blob([Buffer.from('not a zip at all')]), 'b.zip');
  assert.equal((await call('POST', '/admin/backups/restore', tokens.ceo, junk)).status, 400);

  // Restore.
  const fd = new FormData();
  fd.append('pin', CEO_PIN);
  fd.append('backup', new Blob([zip]), 'b.zip');
  const r = await call('POST', '/admin/backups/restore', tokens.ceo, fd);
  assert.equal(r.status, 200, await r.clone().text());
  const { summary } = await r.json();
  assert.equal(summary.counts.orders, 1);
  assert.equal(summary.filesRestored, 1);

  // The CEO session survives; other sessions are ended.
  assert.equal((await call('GET', '/admin/backups', tokens.ceo)).status, 200);
  assert.equal((await call('GET', '/sync', tokens.sales_1)).status, 401);

  // Data is back to the backed-up state, and the file is readable.
  const relog = await call('POST', '/auth/login', undefined, { roleId: 'sales_1', pin: STAFF_PIN });
  tokens.sales_1 = (await relog.json()).token;
  const sync = await (await call('GET', '/sync', tokens.sales_1)).json();
  assert.deepEqual(
    sync.orders.map((o: { proforma: string }) => o.proforma),
    ['1001'],
  );
  const fileRes = await call('GET', `/files/${fileId}`, tokens.sales_1);
  assert.equal(fileRes.status, 200);
  assert.deepEqual(Buffer.from(await fileRes.arrayBuffer()), pdf);

  // A safety backup of the pre-restore state was kept.
  const list = await (await call('GET', '/admin/backups', tokens.ceo)).json();
  assert.ok(list.backups.some((x: { kind: string }) => x.kind === 'safety'));

  // Report figures match the restored data.
  const rep = (await (await call('GET', '/admin/reports/summary', tokens.ceo)).json()).report;
  assert.equal(rep.orders.created, 1);
  assert.equal(rep.orders.amountCreatedToman, 1000000);
  assert.equal(rep.orders.inProgress, 1);
  assert.equal(rep.reps.length, 1);
  assert.equal(rep.reps[0].salesOwnerId, 'sales_1');
  assert.equal(rep.orders.pipelineByStage.find((x: { stage: number }) => x.stage === 2).count, 1);

  // A range that excludes today returns nothing.
  const old = (await (await call('GET', '/admin/reports/summary?from=2020-01-01&to=2020-02-01', tokens.ceo)).json()).report;
  assert.equal(old.orders.created, 0);
});
