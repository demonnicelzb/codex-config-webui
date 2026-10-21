// Edge-case API checks: upstream errors, image forwarding, client abort.
//   node test/api-edge.mjs [port]
import fs from 'node:fs';

const port = Number(process.argv[2] || 8788);
const base = `http://127.0.0.1:${port}`;
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
};

async function readEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
    }
  }
  return events;
}

// 1. unknown model -> the upstream 400 must surface as an error event, not a crash
{
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'definitely-not-a-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const events = await readEvents(res);
  const err = events.find((e) => e.type === 'error');
  check('bad model surfaces an error event', !!err, err ? err.message.slice(0, 90) : 'no error event');
  check('bad model is not a 500', res.status === 200, 'status ' + res.status);
}

// 2. image input forwarded to the vision model
{
  const png = 'C:\\Users\\Administrator\\.dsh\\attachments\\v1\\objects\\a1\\a1ac0cd9ead5f9c6619509ab634868442dac99336f706370eb949cfc64d3645a';
  let dataUrl = null;
  if (fs.existsSync(png)) {
    dataUrl = 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
  }
  if (!dataUrl) {
    console.log('SKIP  image test (sample png not found)');
  } else {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-vision-exp',
        effort: 'low',
        messages: [{ role: 'user', content: '用一个短语描述这张图。', images: [dataUrl] }],
      }),
    });
    const events = await readEvents(res);
    const text = events.filter((e) => e.type === 'text.delta').map((e) => e.text).join('');
    check('vision model accepted the image', text.length > 0, JSON.stringify(text.slice(0, 60)));
  }
}

// 3. text-only model must reject images with a clear message
{
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '看图', images: ['data:image/png;base64,iVBORw0KGgo='] }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  check('text model rejects images', res.status === 400 && /图片/.test(body.error || ''), body.error || '');
}

// 4. client abort must not break the server
{
  const ac = new AbortController();
  const req = fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: ac.signal,
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      effort: 'high',
      messages: [{ role: 'user', content: '写一段 800 字的技术散文，主题是编译器的中间表示。' }],
    }),
  });
  const res = await req;
  const reader = res.body.getReader();
  await reader.read();
  ac.abort();
  await new Promise((r) => setTimeout(r, 400));
  const health = await (await fetch(`${base}/api/health`)).json();
  check('server survives client abort', health.ok === true);
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all edge-case checks passed');
