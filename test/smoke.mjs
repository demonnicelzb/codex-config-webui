// Headless smoke test for the Codex Web server:
//   node test/smoke.mjs [port]
// Verifies /api/bootstrap, then streams a real assistant answer through /api/chat.

const port = Number(process.argv[2] || process.env.PORT || 8788);
const base = `http://127.0.0.1:${port}`;
let failures = 0;

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
}

const boot = await (await fetch(`${base}/api/bootstrap`)).json();
check('bootstrap returns models', Array.isArray(boot.models) && boot.models.length > 0, `${boot.models?.length} models`);
check('bootstrap hides the api key', JSON.stringify(boot).indexOf('sk-') === -1);
check('api key detected', boot.provider.hasKey, `source=${boot.provider.keySource}`);
check('default model resolved', !!boot.defaultModel, boot.defaultModel);
console.log('      endpoint:', boot.endpoint);
console.log('      models  :', boot.models.map((m) => m.slug).join(', '));

const res = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: boot.defaultModel,
    effort: 'low',
    instructions: 'Answer with exactly one short sentence.',
    messages: [{ role: 'user', content: '用一句中文说明什么是幂等性。' }],
  }),
});

check('chat responds with SSE', res.ok && (res.headers.get('content-type') || '').includes('text/event-stream'), `status ${res.status}`);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let text = '';
let reasoning = '';
const events = new Set();

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let sep;
  while ((sep = buffer.indexOf('\n\n')) >= 0) {
    const raw = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    const line = raw.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
    events.add(ev.type);
    if (ev.type === 'text.delta') text += ev.text;
    if (ev.type === 'reasoning.delta') reasoning += ev.text;
  }
}

check('received start event', events.has('start'));
check('received text deltas', text.trim().length > 0, JSON.stringify(text.slice(0, 60)));
check('reasoning streamed', reasoning.length > 0, `${reasoning.length} chars`);
check('completed cleanly', events.has('complete'));
console.log('      events :', [...events].join(', '));

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
