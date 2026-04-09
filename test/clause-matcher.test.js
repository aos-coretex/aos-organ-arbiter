import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoR } from '../lib/bor-loader.js';
import { createClauseMatcher, parseResponse, formatBorForLLM } from '../agents/clause-matcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'test-bor.md');
const seedBorPath = '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops/00-Registry/constitutional-policy/bill-of-rights.md';

// --- Mock LLM clients ---

function mockLlmUnavailable() {
  return {
    isAvailable: () => false,
    chat: async () => { throw new Error('should not be called'); },
    getUsage: () => ({}),
  };
}

function mockLlmReturning(responseText) {
  let lastMessages = null;
  let lastOptions = null;
  return {
    isAvailable: () => true,
    chat: async (messages, options) => {
      lastMessages = messages;
      lastOptions = options;
      return { content: responseText };
    },
    getUsage: () => ({}),
    getLastCall: () => ({ messages: lastMessages, options: lastOptions }),
  };
}

function mockLlmThrowing(errorMsg) {
  return {
    isAvailable: () => true,
    chat: async () => { throw new Error(errorMsg); },
    getUsage: () => ({}),
  };
}

// --- Tests ---

describe('parseResponse', () => {
  it('parses valid JSON response', () => {
    const text = '{"determination":"IN_SCOPE","cited_clauses":[{"clause_id":"I.1","text_ref":"authorized operations","relevance":"covers software development"}],"confidence":0.95,"reasoning":"Clause I.1 explicitly permits this."}';
    const result = parseResponse(text);
    assert.equal(result.determination, 'IN_SCOPE');
    assert.equal(result.cited_clauses.length, 1);
    assert.equal(result.cited_clauses[0].clause_id, 'I.1');
    assert.equal(result.confidence, 0.95);
    assert.ok(result.reasoning.includes('Clause I.1'));
  });

  it('parses JSON from markdown code block', () => {
    const text = '```json\n{"determination":"OUT_OF_SCOPE","cited_clauses":[{"clause_id":"II.1","text_ref":"data exfiltration","relevance":"prohibited"}],"confidence":0.9,"reasoning":"Prohibited by II.1"}\n```';
    const result = parseResponse(text);
    assert.equal(result.determination, 'OUT_OF_SCOPE');
    assert.equal(result.cited_clauses[0].clause_id, 'II.1');
  });

  it('parses JSON embedded in text', () => {
    const text = 'Here is my analysis:\n{"determination":"AMBIGUOUS","cited_clauses":[],"confidence":0.3,"reasoning":"Unclear"}\nEnd.';
    const result = parseResponse(text);
    assert.equal(result.determination, 'AMBIGUOUS');
    assert.equal(result.confidence, 0.3);
  });

  it('returns AMBIGUOUS for invalid JSON', () => {
    const result = parseResponse('This is not JSON at all');
    assert.equal(result.determination, 'AMBIGUOUS');
    assert.equal(result.confidence, 0);
    assert.ok(result.reasoning.includes('Failed to parse'));
  });

  it('rejects invalid determination values', () => {
    const text = '{"determination":"MAYBE","cited_clauses":[],"confidence":0.5,"reasoning":"unsure"}';
    const result = parseResponse(text);
    assert.equal(result.determination, 'AMBIGUOUS');
  });

  it('clamps confidence above 1.0', () => {
    const text = '{"determination":"IN_SCOPE","cited_clauses":[],"confidence":1.5,"reasoning":"very sure"}';
    const result = parseResponse(text);
    assert.equal(result.confidence, 1.0);
  });

  it('clamps confidence below 0.0', () => {
    const text = '{"determination":"IN_SCOPE","cited_clauses":[],"confidence":-0.5,"reasoning":"negative"}';
    const result = parseResponse(text);
    assert.equal(result.confidence, 0);
  });

  it('defaults confidence to 0.5 when not a number', () => {
    const text = '{"determination":"IN_SCOPE","cited_clauses":[],"confidence":"high","reasoning":"test"}';
    const result = parseResponse(text);
    assert.equal(result.confidence, 0.5);
  });

  it('handles missing cited_clauses gracefully', () => {
    const text = '{"determination":"IN_SCOPE","reasoning":"permitted"}';
    const result = parseResponse(text);
    assert.equal(result.determination, 'IN_SCOPE');
    assert.deepEqual(result.cited_clauses, []);
  });

  it('handles empty string', () => {
    const result = parseResponse('');
    assert.equal(result.determination, 'AMBIGUOUS');
  });
});

describe('formatBorForLLM', () => {
  it('produces readable article/clause text from fixture', async () => {
    const bor = await loadBoR(fixturePath);
    const text = formatBorForLLM(bor);
    assert.ok(text.includes('## Article I'));
    assert.ok(text.includes('### Clause I.1'));
    assert.ok(text.includes('software development'));
    assert.ok(text.includes('## Article VI'));
    assert.ok(text.includes('### Clause VI.2'));
  });

  it('handles articles without clauses', () => {
    const bor = {
      articles: [
        { id: 'I', title: 'Test', clauses: [], text: 'Some article text' },
      ],
    };
    const text = formatBorForLLM(bor);
    assert.ok(text.includes('## Article I — Test'));
    assert.ok(text.includes('Some article text'));
  });
});

describe('createClauseMatcher — LLM unavailable', () => {
  it('returns AMBIGUOUS when LLM is not configured', async () => {
    const matcher = createClauseMatcher({ llm: {} }, mockLlmUnavailable());
    const bor = await loadBoR(fixturePath);
    const result = await matcher.evaluate({ action: 'Create a KB entity', bor });

    assert.equal(result.determination, 'AMBIGUOUS');
    assert.equal(result.confidence, 0);
    assert.ok(result.reasoning.includes('unavailable'));
  });

  it('isAvailable returns false', () => {
    const matcher = createClauseMatcher({ llm: {} }, mockLlmUnavailable());
    assert.equal(matcher.isAvailable(), false);
  });
});

describe('createClauseMatcher — placeholder BoR', () => {
  it('returns AMBIGUOUS for placeholder-only BoR', async () => {
    let borLoaded;
    try {
      borLoaded = await loadBoR(seedBorPath);
    } catch {
      // Seed BoR might not exist in all test environments — build a synthetic one
      borLoaded = {
        version: '1.0.0-seed',
        hash: 'abc',
        articles: [
          { id: 'I', title: 'Scope', clauses: [], text: '[To be defined by human principal]' },
          { id: 'II', title: 'Prohibited', clauses: [], text: '[To be defined by human principal]' },
        ],
        raw: '',
        clauseCount: 0,
      };
    }

    const llm = mockLlmReturning('should not be called');
    const matcher = createClauseMatcher({ llm: {} }, llm);
    const result = await matcher.evaluate({ action: 'anything', bor: borLoaded });

    assert.equal(result.determination, 'AMBIGUOUS');
    assert.equal(result.confidence, 0);
    assert.ok(result.reasoning.includes('placeholder'));
  });
});

describe('createClauseMatcher — mocked LLM', () => {
  it('passes BoR text and action to LLM', async () => {
    const llmResponse = JSON.stringify({
      determination: 'IN_SCOPE',
      cited_clauses: [{ clause_id: 'I.1', text_ref: 'authorized operations', relevance: 'permits KB operations' }],
      confidence: 0.92,
      reasoning: 'Clause I.1 explicitly authorizes knowledge management.',
    });
    const llm = mockLlmReturning(llmResponse);
    const matcher = createClauseMatcher({ llm: {} }, llm);
    const bor = await loadBoR(fixturePath);

    const result = await matcher.evaluate({
      action: 'Create a knowledge base entity',
      targets: ['urn:test:entity:1'],
      intent: 'KB management',
      bor,
    });

    assert.equal(result.determination, 'IN_SCOPE');
    assert.equal(result.confidence, 0.92);
    assert.equal(result.cited_clauses[0].clause_id, 'I.1');

    // Verify LLM was called with correct content
    const { messages, options } = llm.getLastCall();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.ok(messages[0].content.includes('Bill of Rights'));
    assert.ok(messages[0].content.includes('Create a knowledge base entity'));
    assert.ok(messages[0].content.includes('urn:test:entity:1'));
    assert.ok(messages[0].content.includes('KB management'));
    assert.ok(options.system.includes('constitutional scope evaluator'));
  });

  it('returns AMBIGUOUS on LLM error (fail-safe)', async () => {
    const llm = mockLlmThrowing('API rate limited');
    const matcher = createClauseMatcher({ llm: {} }, llm);
    const bor = await loadBoR(fixturePath);

    const result = await matcher.evaluate({ action: 'any action', bor });

    assert.equal(result.determination, 'AMBIGUOUS');
    assert.equal(result.confidence, 0);
    assert.ok(result.reasoning.includes('API rate limited'));
    assert.ok(result.reasoning.includes('Escalation required'));
  });

  it('handles LLM returning malformed response', async () => {
    const llm = mockLlmReturning('Sorry, I cannot process that request.');
    const matcher = createClauseMatcher({ llm: {} }, llm);
    const bor = await loadBoR(fixturePath);

    const result = await matcher.evaluate({ action: 'test', bor });

    assert.equal(result.determination, 'AMBIGUOUS');
    assert.ok(result.reasoning.includes('Failed to parse'));
  });
});
