// Interaction flows: stop generation, regenerate, multi-turn context, reload persistence.
//   node test/ui-flows.mjs [pageUrl] [cdpPort]
const pageUrl = process.argv[2] || 'http://127.0.0.1:8788/';
const cdpPort = Number(process.argv[3] || 9333);

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 60000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(interval);
  }
  throw new Error('timeout: ' + label);
}

const targets = await waitFor(async () => {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  return list.find((t) => t.type === 'page') || null;
}, { label: 'CDP page' });
const ws = new WebSocket(targets.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.error ? Promise.reject(new Error(m.error.message)) : m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const myId = id++;
    pending.set(myId, (result) => (result instanceof Promise ? result.then(resolve, reject) : resolve(result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pageUrl });
await sleep(900);
await evaluate('try { localStorage.clear() } catch (e) {}');
await send('Page.reload', { ignoreCache: true });
await waitFor(() => evaluate(`document.querySelectorAll('#modelSelect option').length > 0`), { label: 'boot' });

async function typePrompt(text) {
  await evaluate(`(() => { const el = document.querySelector('#input'); el.focus(); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await send('Input.insertText', { text });
  await sleep(120);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

const snapshot = () => evaluate(`(() => {
  const msgs = [...document.querySelectorAll('#thread .msg')];
  const last = msgs[msgs.length - 1];
  return {
    users: document.querySelectorAll('#thread .msg.user').length,
    assistants: document.querySelectorAll('#thread .msg.assistant').length,
    stopBtn: document.querySelector('#sendBtn').classList.contains('stop'),
    lastText: last ? (last.querySelector('.md')?.innerText || '') : '',
    lastStatus: last ? [...last.querySelectorAll('.status-line')].map((x) => x.innerText).join('|') : '',
    reasoningLen: last?.querySelector('.reasoning-body')?.textContent.length || 0,
    caret: !!document.querySelector('.caret'),
    actions: last ? !!last.querySelector('.msg-actions.visible') : false,
    error: last ? (last.querySelector('.error-box')?.innerText || '') : '',
    convs: document.querySelectorAll('#chatList .chat-item').length,
    title: document.querySelector('#chatTitle').innerText,
  };
})()`);

/* --- 1. stop mid-stream ------------------------------------------------- */
await typePrompt('请写一篇至少 800 字的技术散文，主题是编译器的中间表示 IR。');
const mid = await waitFor(async () => {
  const s = await snapshot();
  // wait until some output (reasoning or text) has actually streamed in
  return s.stopBtn && (s.lastText.trim().length > 0 || s.reasoningLen > 40) ? s : null;
}, { timeout: 45000, label: 'streaming output' });
check('streaming started', mid.stopBtn === true, 'stopBtn=' + mid.stopBtn + ' caret=' + mid.caret);
await evaluate(`document.querySelector('#sendBtn').click()`);
const stopped = await waitFor(async () => {
  const s = await snapshot();
  if (!s.stopBtn && s.lastStatus.includes('已停止')) return s;
  return null;
}, { timeout: 20000, label: 'stopped state' });
check('stop keeps partial output', stopped.lastText.length + stopped.reasoningLen > 0,
  `${stopped.lastText.length} chars text + ${stopped.reasoningLen} chars reasoning kept`);
check('stop restores send button', stopped.stopBtn === false);
check('stopped message has no caret', stopped.caret === false);

/* --- 2. regenerate ------------------------------------------------------ */
await evaluate(`document.querySelector('#newChat').click()`);
await sleep(300);
await typePrompt('用一句话说明什么是编译器的 IR。');
const first = await waitFor(async () => {
  const s = await snapshot();
  return !s.stopBtn && s.actions && s.lastText.length > 10 ? s : null;
}, { timeout: 90000, label: 'first answer' });
check('normal answer completes', first.assistants === 1 && first.lastText.length > 5);

const regenBtn = `[...document.querySelectorAll('#thread .msg.assistant .act-btn')].find(b => b.textContent.includes('重新生成'))`;
await evaluate(`${regenBtn}.click()`);
const regen = await waitFor(async () => {
  const s = await snapshot();
  return !s.stopBtn && s.actions && s.assistants === 1 && s.lastText.length > 10 ? s : null;
}, { timeout: 90000, label: 'regenerated answer' });
check('regenerate produces a single assistant message', regen.assistants === 1, 'assistants=' + regen.assistants);
check('regenerated answer is non-empty', regen.lastText.length > 10);

/* --- 3. multi-turn context --------------------------------------------- */
await typePrompt('用一句话说明刚才我问的是什么。');
const turn2 = await waitFor(async () => {
  const s = await snapshot();
  return !s.stopBtn && s.actions && s.users === 2 && s.assistants === 2 && s.lastText.length > 5 ? s : null;
}, { timeout: 90000, label: 'second turn' });
check('second turn rendered', turn2.users === 2 && turn2.assistants === 2);
check('second turn has no error', !turn2.error, turn2.error.slice(0, 80));

/* --- 4. persistence after reload --------------------------------------- */
const beforeReload = await snapshot();
await send('Page.reload', { ignoreCache: true });
await waitFor(() => evaluate(`document.querySelectorAll('#modelSelect option').length > 0`), { label: 'reboot' });
const after = await snapshot();
check('conversations persist across reload', after.convs >= 1, 'sidebar items=' + after.convs);
check('messages persist across reload', after.assistants >= 1, 'assistants=' + after.assistants);
check('title persists', after.title === beforeReload.title, JSON.stringify(after.title));
check('no error banner after reload', !after.error, after.error.slice(0, 80));

console.log('');
ws.close();
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all interaction checks passed');
process.exit(0);
