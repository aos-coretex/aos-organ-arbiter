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

  // LLM settings root (consumed by `@coretex/organ-boot/llm-settings-loader`).
  // The loader reads `<settingsRoot>/190-Arbiter/arbiter-organ-{default,clause-matcher}-llm-settings.yaml`.
  // No hardcoded model strings — settings YAML is the source of truth (MP-CONFIG-1 R5).
  settingsRoot: process.env.SETTINGS_ROOT || `${vaultRoot}/01-Organs`,

  env,
};
