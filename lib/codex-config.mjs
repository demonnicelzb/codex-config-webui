// Minimal TOML subset parser + Codex config/catalog resolver.
// Reads the same files the Codex CLI uses (~/.codex/config.toml and models.json)
// so the web UI reuses the existing provider, API key and model catalog.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ TOML --- */

function stripComment(line) {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inBasic) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inBasic = false;
    } else if (inLiteral) {
      if (c === "'") inLiteral = false;
    } else if (c === '"') {
      inBasic = true;
    } else if (c === "'") {
      inLiteral = true;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitKeyPath(key) {
  const parts = [];
  let buf = '';
  let quote = null;
  for (const c of key) {
    if (quote) {
      if (c === quote) quote = null;
      else buf += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '.') {
      parts.push(buf.trim());
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((p) => parseValue(p));
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const out = {};
    for (const pair of v.slice(1, -1).split(',')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const k = pair.slice(0, eq).trim().replace(/^["']|["']$/g, '');
      out[k] = parseValue(pair.slice(eq + 1));
    }
    return out;
  }
  return v;
}

export function parseToml(text) {
  const root = {};
  let cur = root;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith('[[') ) continue; // array-of-tables not needed here
    if (line.startsWith('[') && line.endsWith(']')) {
      const keyPath = splitKeyPath(line.slice(1, -1).trim());
      cur = root;
      for (const k of keyPath) {
        if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
        cur = cur[k];
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const keyPath = splitKeyPath(line.slice(0, eq).trim());
    if (!keyPath.length) continue;
    let node = cur;
    for (const k of keyPath.slice(0, -1)) {
      if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
      node = node[k];
    }
    node[keyPath[keyPath.length - 1]] = parseValue(line.slice(eq + 1));
  }
  return root;
}

/* --------------------------------------------------------------- helpers --- */

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readJson(p) {
  const t = readText(p);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

const BUILTIN_MODELS = [
  {
    slug: 'deepseek-v4-pro',
    display_name: 'DeepSeek-V4-Pro',
    description: 'Most capable frontier agentic coding model.',
    default_reasoning_level: 'high',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'high', description: 'Extra high reasoning depth for complex problems' },
      { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
    ],
    input_modalities: ['text'],
    priority: 1,
  },
  {
    slug: 'deepseek-v4-flash',
    display_name: 'DeepSeek-V4-Flash',
    description: 'Latest frontier agentic coding model.',
    default_reasoning_level: 'high',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'high', description: 'Extra high reasoning depth for complex problems' },
      { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
    ],
    input_modalities: ['text'],
    priority: 2,
  },
];

export function normalizeBaseUrl(base_url) {
  return String(base_url || '').trim().replace(/\/+$/, '');
}

function providerFromConfig(config) {
  const providers = config.model_providers || {};
  const id = config.model_provider || (providers.deepseek ? 'deepseek' : 'openai');
  const raw = providers[id] || {};
  const isOpenAI = id === 'openai' && !providers.openai;
  return {
    id,
    name: raw.name || id,
    baseUrl: normalizeBaseUrl(raw.base_url || (isOpenAI ? 'https://api.openai.com/v1' : 'https://api.deepseek.com')),
    wireApi: raw.wire_api === 'chat' ? 'chat' : 'responses',
    envKey: raw.env_key || (id === 'openai' ? 'OPENAI_API_KEY' : `${id.toUpperCase()}_API_KEY`),
    experimentalToken: raw.experimental_bearer_token || null,
    requiresOpenAiAuth: !!raw.requires_openai_auth,
  };
}

function resolveApiKey(provider, codexHome) {
  if (provider.experimentalToken) return { key: provider.experimentalToken, source: 'config.toml' };
  const auth = readJson(path.join(codexHome, 'auth.json'));
  if (auth) {
    if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) {
      return { key: auth.OPENAI_API_KEY, source: 'auth.json' };
    }
    if (auth.tokens && auth.tokens.access_token) {
      return { key: auth.tokens.access_token, source: 'auth.json (token)' };
    }
  }
  for (const envName of [provider.envKey, 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY']) {
    if (envName && process.env[envName]) return { key: process.env[envName], source: `env ${envName}` };
  }
  return { key: null, source: null };
}

function normalizeCatalogModels(catalog) {
  const list = Array.isArray(catalog?.models) ? catalog.models : [];
  const models = [];
  for (const m of list) {
    if (!m || !m.slug) continue;
    if (m.supported_in_api === false) continue;
    if (m.visibility && m.visibility !== 'list') continue;
    const levels = Array.isArray(m.supported_reasoning_levels) && m.supported_reasoning_levels.length
      ? m.supported_reasoning_levels.map((l) => ({ effort: l.effort, description: l.description || '' }))
      : [{ effort: 'low', description: '' }, { effort: 'high', description: '' }];
    models.push({
      slug: m.slug,
      displayName: m.display_name || m.slug,
      description: m.description || '',
      defaultReasoningLevel: m.default_reasoning_level || levels[0].effort,
      reasoningLevels: levels,
      inputModalities: Array.isArray(m.input_modalities) ? m.input_modalities : ['text'],
      priority: typeof m.priority === 'number' ? m.priority : 100,
    });
  }
  models.sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
  return models;
}

/**
 * Load everything the server needs from the local Codex installation.
 * Never throws: missing files fall back to sensible defaults.
 */
export function loadCodexEnvironment({ codexHome = CODEX_HOME } = {}) {
  const configPath = path.join(codexHome, 'config.toml');
  const configText = readText(configPath);
  const config = configText ? parseToml(configText) : {};
  const provider = providerFromConfig(config);

  const catalogPath = config.model_catalog_json
    ? path.resolve(codexHome, String(config.model_catalog_json))
    : path.join(codexHome, 'models.json');
  let catalog = readJson(catalogPath);
  let catalogSource = catalogPath;
  if (!catalog) {
    catalog = { models: BUILTIN_MODELS };
    catalogSource = null;
  }

  const models = normalizeCatalogModels(catalog);
  const auth = resolveApiKey(provider, codexHome);

  const defaultModel = models.some((m) => m.slug === config.model)
    ? config.model
    : (models[0]?.slug || 'deepseek-v4-pro');
  const modelMeta = models.find((m) => m.slug === defaultModel) || models[0];
  const defaultEffort = String(config.model_reasoning_effort || modelMeta?.defaultReasoningLevel || 'high');

  const endpoint = provider.wireApi === 'chat'
    ? `${provider.baseUrl}/chat/completions`
    : `${provider.baseUrl}/responses`;

  return {
    codexHome,
    configPath,
    configFound: !!configText,
    catalogPath: catalogSource,
    // `apiKey` is server-side only — safePublicEnvironment never exposes it.
    apiKey: auth.key,
    provider: { ...provider, hasKey: !!auth.key, keySource: auth.source },
    models,
    defaultModel,
    defaultEffort,
    endpoint,
  };
}

export function safePublicEnvironment(env) {
  return {
    codexHome: env.codexHome,
    configPath: env.configPath,
    configFound: env.configFound,
    catalogPath: env.catalogPath,
    provider: {
      id: env.provider.id,
      name: env.provider.name,
      baseUrl: env.provider.baseUrl,
      wireApi: env.provider.wireApi,
      hasKey: env.provider.hasKey,
      keySource: env.provider.keySource,
    },
    models: env.models,
    defaultModel: env.defaultModel,
    defaultEffort: env.defaultEffort,
    endpoint: env.endpoint,
  };
}
