#!/usr/bin/env node
/**
 * Codex Web — a browser chat front-end for the same provider the Codex CLI uses.
 *
 * Zero dependencies: static file server + streaming proxy to the Responses API.
 * The API key never leaves the server; the browser only sees normalized SSE.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadCodexEnvironment, safePublicEnvironment, normalizeBaseUrl } from './lib/codex-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const HOST = argValue('--host') || process.env.HOST || '127.0.0.1';
const BASE_PORT = Number(argValue('--port') || process.env.PORT || 8788);
const OPEN_BROWSER = !argv.includes('--no-open') && process.env.CODEX_WEB_NO_OPEN !== '1';
const MAX_BODY = 32 * 1024 * 1024; // images are inlined as data URLs

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const env = loadCodexEnvironment();
const publicEnv = safePublicEnvironment(env);

function log(...parts) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`\x1b[90m[${t}]\x1b[0m`, ...parts);
}

/* --------------------------------------------------------------- helpers --- */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体过大（图片总大小超过 32MB）');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text);
}

/** Turn a chat history into Responses API `input` items. */
function buildInput(messages) {
  const input = [];
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === 'user') {
      const images = Array.isArray(m.images) ? m.images.filter((x) => typeof x === 'string' && x.startsWith('data:image/')) : [];
      const text = String(m.content ?? '');
      if (!images.length) {
        if (text.trim()) input.push({ role: 'user', content: text });
        continue;
      }
      const content = [];
      if (text.trim()) content.push({ type: 'input_text', text });
      for (const url of images) content.push({ type: 'input_image', image_url: url });
      input.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const text = String(m.content ?? '');
      if (text.trim()) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    }
  }
  return input;
}

function upstreamCandidates(live = env) {
  const base = normalizeBaseUrl(live.provider.baseUrl);
  if (live.provider.wireApi === 'chat') {
    return [base + '/chat/completions', base + '/v1/chat/completions'];
  }
  const primary = base + '/responses';
  const fallback = base + '/v1/responses';
  return primary === fallback ? [primary] : [primary, fallback];
}

function extractErrorMessage(status, text) {
  try {
    const j = JSON.parse(text);
    if (j?.error?.message) return `上游接口 ${status}: ${j.error.message}`;
    if (typeof j?.error === 'string') return `上游接口 ${status}: ${j.error}`;
  } catch { /* not json */ }
  const snippet = String(text || '').slice(0, 300).trim();
  return `上游接口 ${status}${snippet ? ': ' + snippet : ''}`;
}

function mapUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    input: u.input_tokens ?? u.prompt_tokens ?? 0,
    output: u.output_tokens ?? u.completion_tokens ?? 0,
    reasoning: u.output_tokens_details?.reasoning_tokens
      ?? u.completion_tokens_details?.reasoning_tokens
      ?? 0,
    cached: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    total: u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
  };
}

/* ------------------------------------------------------------ chat stream --- */

async function handleChat(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message || '无效的 JSON 请求体' });
  }

  // Re-read the Codex config on every request: edits to config.toml (key, model,
  // provider) take effect without restarting the server.
  const live = loadCodexEnvironment();
  if (!live.provider.hasKey) {
    return sendJson(res, 400, {
      error: `未找到 API Key。请在 ${live.configPath} 的 [model_providers.${live.provider.id}] 中配置 experimental_bearer_token，或设置环境变量 ${live.provider.envKey}。`,
    });
  }

  const model = String(payload.model || live.defaultModel);
  const known = live.models.find((m) => m.slug === model);
  const effort = String(payload.effort || live.defaultEffort);
  const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim() : '';
  const input = buildInput(payload.messages);
  if (!input.length) return sendJson(res, 400, { error: '对话内容为空' });

  const wantsImages = input.some((item) => Array.isArray(item.content)
    && item.content.some((part) => part.type === 'input_image'));
  if (wantsImages && known && !known.inputModalities.includes('image')) {
    return sendJson(res, 400, {
      error: `模型 ${known.displayName} 不支持图片输入，请切换到支持图片的模型（例如 deepseek-v4-flash-vision-exp）。`,
    });
  }

  const upstreamBody = {
    model,
    input,
    stream: true,
    store: false,
    reasoning: { effort, summary: 'auto' },
  };
  if (instructions) upstreamBody.instructions = instructions;
  if (Number.isFinite(payload.maxOutputTokens) && payload.maxOutputTokens > 0) {
    upstreamBody.max_output_tokens = Math.floor(payload.maxOutputTokens);
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const ac = new AbortController();
  let closed = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      ac.abort();
    }
  });

  const writeEvent = (type, data) => {
    if (closed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  const started = Date.now();
  let received = false;
  let textLength = 0;
  let reasoningLength = 0;

  try {
    const candidates = upstreamCandidates(live);
    let upstream = null;
    let lastError = null;

    for (const url of candidates) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${live.apiKey}`,
          },
          body: JSON.stringify(upstreamBody),
          signal: ac.signal,
        });
        if (r.ok) {
          upstream = r;
          break;
        }
        const text = await r.text();
        lastError = extractErrorMessage(r.status, text);
        // Only a routing miss (404/405) is worth retrying on the alternate path.
        if (r.status !== 404 && r.status !== 405) break;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = `连接上游接口失败: ${err.message}`;
      }
    }

    if (!upstream) throw new Error(lastError || '无法连接上游接口');

    writeEvent('start', { model, effort, endpoint: upstream.url || candidates[0] });

    if (live.provider.wireApi === 'chat') {
      await streamChatCompletions(upstream, { writeEvent, ac, onText: (n) => { textLength += n; }, onReasoning: (n) => { reasoningLength += n; } });
    } else {
      await streamResponses(upstream, { writeEvent, ac, onText: (n) => { textLength += n; }, onReasoning: (n) => { reasoningLength += n; } });
    }
    received = true;
    writeEvent('done', { ms: Date.now() - started });
  } catch (err) {
    if (err.name === 'AbortError') {
      writeEvent('aborted', { ms: Date.now() - started });
    } else {
      writeEvent('error', { message: err.message || String(err) });
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    log(
      `chat ${model} effort=${effort} -> ${received ? '\x1b[32mok\x1b[0m' : '\x1b[33mstopped/error\x1b[0m'}`,
      `· ${secs}s · out ${textLength}B · think ${reasoningLength}B`,
    );
  }
}

/** Responses API SSE → normalized events. */
async function streamResponses(upstream, { writeEvent, onText, onReasoning }) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const handle = (event, data) => {
    switch (event) {
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
        if (data.delta) { writeEvent('reasoning.delta', { text: data.delta }); onReasoning(data.delta.length); }
        break;
      case 'response.output_text.delta':
        if (data.delta) { writeEvent('text.delta', { text: data.delta }); onText(data.delta.length); }
        break;
      case 'response.refusal.delta':
        if (data.delta) { writeEvent('text.delta', { text: data.delta }); onText(data.delta.length); }
        break;
      case 'response.completed':
        /* fall through */
      case 'response.done':
        writeEvent('complete', {
          usage: mapUsage(data.response?.usage),
          responseId: data.response?.id || null,
          status: data.response?.status || 'completed',
          incomplete: data.response?.incomplete_details || null,
        });
        finished = true;
        break;
      case 'response.incomplete':
        writeEvent('complete', {
          usage: mapUsage(data.response?.usage),
          responseId: data.response?.id || null,
          status: 'incomplete',
          incomplete: data.response?.incomplete_details || null,
        });
        finished = true;
        break;
      case 'response.failed':
      case 'error':
        writeEvent('error', { message: data.error?.message || data.response?.error?.message || '上游返回错误' });
        finished = true;
        break;
      default:
        break;
    }
  };

  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let eventName = 'message';
      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const dataStr = dataLines.join('\n');
      if (dataStr === '[DONE]') { finished = true; break; }
      let data;
      try { data = JSON.parse(dataStr); } catch { continue; }
      handle(data.type || eventName, data);
    }
  }
}

/** Chat Completions SSE → normalized events (wire_api = "chat" fallback). */
async function streamChatCompletions(upstream, { writeEvent, onText, onReasoning }) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  let usage = null;

  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (dataStr === '[DONE]') { finished = true; break; }
      let data;
      try { data = JSON.parse(dataStr); } catch { continue; }
      if (data.usage) usage = mapUsage(data.usage);
      const choice = data.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.reasoning_content) { writeEvent('reasoning.delta', { text: delta.reasoning_content }); onReasoning(delta.reasoning_content.length); }
      if (delta.content) { writeEvent('text.delta', { text: delta.content }); onText(delta.content.length); }
      if (choice.finish_reason) {
        writeEvent('complete', { usage, responseId: data.id || null, status: 'completed', incomplete: null });
        finished = true;
      }
    }
  }
}

/* ---------------------------------------------------------------- router --- */

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return serveStatic(req, res, path.posix.join(rel, 'index.html'));
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': ext === '.html' ? 'no-store' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    if (path.extname(filePath)) return sendJson(res, 404, { error: 'not found' });
    // SPA fallback
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    const body = await fsp.readFile(indexPath);
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'content-length': body.length });
    res.end(body);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/bootstrap') {
      return sendJson(res, 200, {
        ...publicEnv,
        version: '1.0.0',
        now: Date.now(),
      });
    }
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime() });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      return handleChat(req, res);
    }
    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: `unknown api: ${url.pathname}` });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    log('\x1b[31mrequest failed\x1b[0m', req.method, req.url, err.message);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || 'internal error' });
    else if (!res.writableEnded) res.end();
  }
});

/* ------------------------------------------------------------------ boot --- */

function listen(port, attempts = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts < 20) {
      listen(port + 1, attempts + 1);
    } else {
      console.error('启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => onListening(port));
}

function onListening(port) {
  const url = `http://${HOST}:${port}`;
  console.log('');
  console.log('  \x1b[1mCodex Web\x1b[0m  \x1b[90mv1.0.0 · 浏览器对话端\x1b[0m');
  console.log('');
  console.log(`  \x1b[36m➜\x1b[0m  ${url}`);
  console.log('');
  console.log(`  provider  \x1b[90m${env.provider.name}\x1b[0m  ${env.provider.baseUrl}`);
  console.log(`  model     \x1b[90m${env.defaultModel}\x1b[0m   effort \x1b[90m${env.defaultEffort}\x1b[0m`);
  console.log(`  api key   ${env.provider.hasKey ? '\x1b[32m已就绪\x1b[0m \x1b[90m(' + env.provider.keySource + ')\x1b[0m' : '\x1b[31m缺失\x1b[0m'}`);
  console.log(`  config    \x1b[90m${env.configFound ? env.configPath : '未找到，使用默认值'}\x1b[0m`);
  console.log('');
  console.log('  \x1b[90m按 Ctrl+C 停止服务\x1b[0m');
  console.log('');

  if (OPEN_BROWSER) {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch { /* opening the browser is best-effort */ }
  }
  if (env.configFound && !env.provider.hasKey) {
    log('\x1b[33m警告\x1b[0m 配置中没有找到 API Key，对话请求会失败。');
  }
}

process.on('SIGINT', () => {
  console.log('\n已停止。');
  process.exit(0);
});

listen(BASE_PORT);
