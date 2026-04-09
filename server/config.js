/**
 * Arbiter configuration — environment-driven, AOS/SAAS aware.
 */

const env = process.env.NODE_ENV || 'development';
const isAOS = env !== 'production';

const vaultRoot = process.env.VAULT_ROOT
  || '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops';

export default {
  name: 'Arbiter',
  port: parseInt(process.env.ARBITER_PORT || (isAOS ? '4021' : '3921'), 10),
  binding: '127.0.0.1',
  spineUrl: process.env.SPINE_URL || (isAOS ? 'http://127.0.0.1:4000' : 'http://127.0.0.1:3900'),
  graphUrl: process.env.GRAPH_URL || (isAOS ? 'http://127.0.0.1:4020' : 'http://127.0.0.1:3920'),

  // BoR document path
  borPath: process.env.BOR_PATH
    || `${vaultRoot}/00-Registry/constitutional-policy/bill-of-rights.md`,
  vaultRoot,

  // LLM configuration for clause matching agent
  llm: {
    model: process.env.ARBITER_MODEL || 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 2048,
  },

  env,
};
