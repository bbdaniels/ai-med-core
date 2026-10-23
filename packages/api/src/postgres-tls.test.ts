// Run: npm -w @ai-med/api test
//
// Postgres TLS follows DATABASE_URL's sslmode (db/connection.ts), read by
// node-postgres itself with libpq's meanings. Checked on the connection
// parameters node-postgres builds from the string the pool is given, so no
// server is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { postgresConnectionString } from './db/connection.js';

const BASE = 'postgresql://app:s%40cret@db:5432/aimed';
const ssl = (url: string) => {
  const saved = process.env.PGSSLMODE;
  delete process.env.PGSSLMODE;
  try {
    // A client is built, never connected: its parameters are the ones a pool's clients get.
    return (new pg.Client({ connectionString: postgresConnectionString(url) }) as any).connectionParameters.ssl;
  } finally {
    if (saved !== undefined) process.env.PGSSLMODE = saved;
  }
};

test('no sslmode, or disable, is no TLS (the Pi: Postgres on the compose network)', () => {
  assert.equal(ssl(BASE), false);
  assert.equal(ssl(`${BASE}?sslmode=disable`), false);
});

test('require is TLS without verification, as libpq (and as the server forced before)', () => {
  assert.deepEqual(ssl(`${BASE}?sslmode=require`), { rejectUnauthorized: false });
});

test('verify-full verifies the certificate and the host name; verify-ca without a CA is refused', () => {
  const full = ssl(`${BASE}?sslmode=verify-full`);
  assert.equal(typeof full, 'object');
  assert.notEqual(full.rejectUnauthorized, false);
  assert.equal(full.checkServerIdentity, undefined);
  assert.throws(() => ssl(`${BASE}?sslmode=verify-ca`), /sslrootcert/);
});

test('the rest of the URL is kept, and an explicit uselibpqcompat is respected', () => {
  const out = new URL(postgresConnectionString(`${BASE}?sslmode=require&application_name=api`));
  assert.equal(out.password, 's%40cret');
  assert.equal(out.searchParams.get('application_name'), 'api');
  assert.equal(out.searchParams.get('uselibpqcompat'), 'true');
  assert.equal(new URL(postgresConnectionString(`${BASE}?uselibpqcompat=false`)).searchParams.get('uselibpqcompat'), 'false');
});
