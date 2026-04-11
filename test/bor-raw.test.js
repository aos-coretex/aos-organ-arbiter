import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createBorRoutes } from '../server/routes/bor.js';
import { loadBoR } from '../lib/bor-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'test-bor.md');

function req(server, method, path) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = { hostname: '127.0.0.1', port: addr.port, path, method };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

describe('GET /bor/raw — loaded state', () => {
  let server, fixtureRaw, fixtureMtime;

  before(async () => {
    const bor = await loadBoR(fixturePath);
    const fileStat = await stat(fixturePath);
    fixtureRaw = await readFile(fixturePath, 'utf-8');
    fixtureMtime = fileStat.mtime.toISOString();

    const borState = {
      loaded: true,
      version: bor.version,
      hash: bor.hash,
      clauseCount: bor.clauseCount,
      raw: bor.raw,
      effectiveSince: fixtureMtime,
      loadedAt: new Date().toISOString(),
    };

    const app = express();
    app.use(createBorRoutes({ config: { borPath: fixturePath }, borState }));
    server = await new Promise(resolve => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  it('returns 200 with version, hash, raw_text, effective_since, loaded_at', async () => {
    const res = await req(server, 'GET', '/bor/raw');
    assert.equal(res.status, 200);
    assert.equal(res.body.version, 'test-1.0.0');
    assert.equal(res.body.hash.length, 64);
    assert.equal(typeof res.body.raw_text, 'string');
    assert.ok(res.body.raw_text.length > 0);
    assert.equal(res.body.effective_since, fixtureMtime);
    assert.ok(res.body.loaded_at);
    assert.doesNotThrow(() => new Date(res.body.loaded_at));
  });

  it('raw_text matches the file content the loader parsed', async () => {
    const res = await req(server, 'GET', '/bor/raw');
    assert.equal(res.body.raw_text, fixtureRaw);
  });

  it('hash matches SHA-256 of raw_text', async () => {
    const res = await req(server, 'GET', '/bor/raw');
    const recomputed = createHash('sha256').update(res.body.raw_text, 'utf-8').digest('hex');
    assert.equal(res.body.hash, recomputed);
  });
});

describe('GET /bor/raw — unloaded state', () => {
  let server;

  before(async () => {
    const app = express();
    app.use(createBorRoutes({ config: { borPath: fixturePath }, borState: null }));
    server = await new Promise(resolve => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  it('returns 503 BOR_NOT_LOADED when borState is null', async () => {
    const res = await req(server, 'GET', '/bor/raw');
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'BOR_NOT_LOADED');
  });
});
