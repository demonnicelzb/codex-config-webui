// Headless UI test: drives the real page over CDP — types a prompt, hits Enter,
// waits for the streamed answer to finish, then writes a screenshot.
//   node test/ui-shot.mjs [pageUrl] [outPng] [port]
import fs from 'node:fs';

const pageUrl = process.argv[2] || 'http://127.0.0.1:8788/';
const outPng = process.argv[3] || '.shots/live.png';
const cdpPort = Number(process.argv[4] || 9333);

async function waitFor(fn, { timeout = 30000, interval = 200, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const list = await waitFor(async () => {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const targets = await r.json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'))
    || targets.find((t) => t.type === 'page' && t.url === 'about:blank')
    || targets.find((t) => t.type === 'page');
  return page || null;
}, { timeout: 20000, label: 'CDP page target' }).catch(async () => {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  console.log(await r.text());
  throw new Error('no page target');
});

const ws = new WebSocket(list.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleErrors = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// Navigate explicitly: the browser may open on a first-run/about:blank tab.
await send('Page.navigate', { url: pageUrl });
await new Promise((r) => setTimeout(r, 900));
// Start from a clean slate so repeated runs never inherit conversations.
await evaluate('try { localStorage.clear() } catch (e) {}');
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 900));

// 1. app booted?
await waitFor(() => evaluate(`document.querySelectorAll('#modelSelect option').length > 0`), { label: 'model list' });
console.log('boot ok — model =', await evaluate(`document.querySelector('#modelSelect').value`));

// 2. type a prompt like a user would
const prompt = '用一句话解释什么是幂等性，然后给出一个 Python 代码示例（不超过 12 行）。';
await evaluate(`window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); (() => { const el = document.querySelector('#input'); el.focus(); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
await send('Input.insertText', { text: prompt });
await new Promise((r) => setTimeout(r, 150));
const typed = await evaluate(`document.querySelector('#input').value`);
console.log('typed ok — length', typed.length);

// 3. press Enter
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

console.log('sent, waiting for stream…');
const started = Date.now();
let sawReasoning = false;
let sawText = false;
let lastLen = 0;

const finalState = await waitFor(async () => {
  const snap = await evaluate(`(() => {
    const msgs = [...document.querySelectorAll('#thread .msg')];
    const last = msgs[msgs.length - 1];
    if (!last) return { none: true };
    const md = last.querySelector('.md');
    const reasoning = last.querySelector('.reasoning-body');
    const streaming = !!last.querySelector('.caret');
    const err = last.querySelector('.error-box');
    const actions = last.querySelector('.msg-actions');
    return {
      count: msgs.length,
      text: md ? md.innerText : '',
      reasoning: reasoning ? reasoning.textContent : '',
      streaming,
      error: err ? err.innerText : '',
      actionsVisible: actions ? actions.classList.contains('visible') : false,
      usage: last.querySelector('.usage') ? last.querySelector('.usage').innerText : '',
      stopBtn: document.querySelector('#sendBtn').classList.contains('stop'),
    };
  })()`);
  if (snap.none) return null;
  if (snap.reasoning) sawReasoning = true;
  if (snap.text && snap.text.length > lastLen) sawText = true;
  lastLen = snap.text ? snap.text.length : 0;
  if (snap.error) return { ...snap, done: true };
  if (snap.text && snap.text.length > 20 && snap.actionsVisible && !snap.streaming) return { ...snap, done: true };
  if (Date.now() - started > 60000 && Math.random() < 0.02) {
    console.log('still waiting…', JSON.stringify({ lastLen, streaming: snap.streaming, actions: snap.actionsVisible, count: snap.count }));
  }
  return null;
}, { timeout: 120000, interval: 300, label: 'streamed answer' }).catch(async (err) => {
  console.log('TIMEOUT:', err.message);
  const diag = await evaluate(`(() => ({
    errs: window.__errs || [],
    caret: !!document.querySelector('.caret'),
    sendBtn: document.querySelector('#sendBtn').className,
    body: document.querySelector('#thread').innerText.slice(-800),
  }))()`).catch((e) => ({ evalFailed: String(e) }));
  console.log('page errors :', JSON.stringify(diag.errs));
  console.log('page state  :', JSON.stringify({ caret: diag.caret, sendBtn: diag.sendBtn, evalFailed: diag.evalFailed }));
  console.log('thread tail :', String(diag.body || '').slice(-500));
  process.exit(2);
});

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log('answer received in', elapsed + 's');
console.log('--- text ---\n' + finalState.text.slice(0, 700));
console.log('--- reasoning bytes ---', finalState.reasoning.length);
console.log('--- usage ---', finalState.usage);
console.log('streaming seen:', 'text=' + sawText, 'reasoning=' + sawReasoning);
if (consoleErrors.length) console.log('console errors:', consoleErrors.slice(0, 5));

// 4. screenshots: full conversation from the top, then with reasoning expanded
await new Promise((r) => setTimeout(r, 600));
await evaluate(`document.querySelector('#viewport').scrollTo({top:0,behavior:'auto'})`);
await new Promise((r) => setTimeout(r, 400));
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.mkdirSync('.shots', { recursive: true });
fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
console.log('screenshot written to', outPng);

const opened = await evaluate(`(() => {
  const d = document.querySelector('#thread .reasoning');
  if (!d) return false;
  d.open = true;
  const v = document.querySelector('#viewport');
  v.scrollTop = 0;
  return true;
})()`);
if (opened) {
  await new Promise((r) => setTimeout(r, 350));
  const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const alt = outPng.replace(/\.png$/, '-reasoning.png');
  fs.writeFileSync(alt, Buffer.from(shot2.data, 'base64'));
  console.log('reasoning screenshot written to', alt);
}

// 5. tiny sanity assertions
const failures = [];
if (!finalState.text || finalState.text.length < 10) failures.push('assistant text missing');
if (finalState.error) failures.push('error box shown: ' + finalState.error);
if (finalState.streaming) failures.push('still streaming after completion');
if (!finalState.actionsVisible) failures.push('message actions not revealed');
if (!sawText) failures.push('no incremental text observed');
if (/<[a-z]/i.test(finalState.text)) failures.push('raw html leaked into text');
console.log(failures.length ? 'FAILURES: ' + failures.join(' | ') : 'UI checks passed');
ws.close();
process.exit(failures.length ? 1 : 0);
