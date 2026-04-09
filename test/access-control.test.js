import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requireAuthorizedSource, validateSpineSource } from '../lib/access-control.js';

describe('requireAuthorizedSource middleware', () => {
  function mockReq(sourceOrgan) {
    return {
      headers: { 'x-source-organ': sourceOrgan },
      body: {},
      path: '/scope-query',
      method: 'POST',
      ip: '127.0.0.1',
    };
  }
  function mockRes() {
    let _statusCode, _body;
    return {
      status(code) { _statusCode = code; return this; },
      json(data) { _body = data; },
      get statusCode() { return _statusCode; },
      get body() { return _body; },
    };
  }

  it('allows Nomos', (_, done) => {
    const req = mockReq('Nomos');
    const res = mockRes();
    requireAuthorizedSource(req, res, () => {
      assert.equal(req.sourceOrgan, 'Nomos');
      done();
    });
  });

  it('allows Human_Principal', (_, done) => {
    const req = mockReq('Human_Principal');
    const res = mockRes();
    requireAuthorizedSource(req, res, () => {
      assert.equal(req.sourceOrgan, 'Human_Principal');
      done();
    });
  });

  it('allows human_principal (lowercase)', (_, done) => {
    const req = mockReq('human_principal');
    const res = mockRes();
    requireAuthorizedSource(req, res, () => {
      assert.equal(req.sourceOrgan, 'human_principal');
      done();
    });
  });

  it('rejects unauthorized organ', () => {
    const req = mockReq('Thalamus');
    const res = mockRes();
    requireAuthorizedSource(req, res, () => assert.fail('should not call next'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'UNAUTHORIZED_QUERIER');
  });

  it('rejects missing source', () => {
    const req = { headers: {}, body: {}, path: '/scope-query', method: 'POST', ip: '127.0.0.1' };
    const res = mockRes();
    requireAuthorizedSource(req, res, () => assert.fail('should not call next'));
    assert.equal(res.statusCode, 403);
  });

  it('falls back to body.requester', (_, done) => {
    const req = { headers: {}, body: { requester: 'Nomos' }, path: '/scope-query', method: 'POST', ip: '127.0.0.1' };
    const res = mockRes();
    requireAuthorizedSource(req, res, () => {
      assert.equal(req.sourceOrgan, 'Nomos');
      done();
    });
  });
});

describe('validateSpineSource', () => {
  it('authorizes Nomos in Spine envelope', () => {
    const result = validateSpineSource({ source_organ: 'Nomos' });
    assert.equal(result.authorized, true);
    assert.equal(result.source, 'Nomos');
  });

  it('authorizes Human_Principal in Spine envelope', () => {
    const result = validateSpineSource({ source_organ: 'Human_Principal' });
    assert.equal(result.authorized, true);
  });

  it('rejects unauthorized Spine source', () => {
    const result = validateSpineSource({ source_organ: 'Glia' });
    assert.equal(result.authorized, false);
  });

  it('rejects missing source', () => {
    const result = validateSpineSource({});
    assert.equal(result.authorized, false);
    assert.equal(result.source, 'unknown');
  });

  it('reads source from nested payload', () => {
    const result = validateSpineSource({ payload: { source_organ: 'Nomos' } });
    assert.equal(result.authorized, true);
    assert.equal(result.source, 'Nomos');
  });
});
