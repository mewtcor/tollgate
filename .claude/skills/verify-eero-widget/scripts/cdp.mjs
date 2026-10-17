// Drive the running widget over Chrome DevTools Protocol (WebView2 remote debugging). Needs Node 22+.
//   node cdp.mjs targets
//   node cdp.mjs eval  '<js expression>'          prints the JSON value
//   node cdp.mjs wait  '<js expression>' [ms]     polls until truthy, exit 1 on timeout (default 15000)
//   node cdp.mjs click '<css selector>'
//   node cdp.mjs fill  '<css selector>' '<value>' sets value, fires input + change
//   node cdp.mjs key   '<css selector>' '<key>'   fires keydown, e.g. Enter
//   node cdp.mjs shot  <path.png>
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const port = process.env.CDP_PORT || 9333;
const [cmd, a, b] = process.argv.slice(2);
const fail = (msg) => { console.error(msg); process.exit(1); };

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => fail(`no debugger on port ${port}`));
const page = targets.find((t) => t.type === 'page');
if (!page) fail('no page target');
if (cmd === 'targets') {
  console.log(JSON.stringify(targets.map(({ type, title, url }) => ({ type, title, url }))));
  process.exit(0);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let n = 0;
const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); waiting.get(d.id)?.(d); };
const send = (method, params = {}) => new Promise((ok) => { waiting.set(++n, ok); ws.send(JSON.stringify({ id: n, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.error) throw new Error(r.error.message);
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result.result.value;
};
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const need = (sel) => `(() => { const e = ${q(sel)}; if (!e) throw new Error('no element ' + ${JSON.stringify(sel)}); return e; })()`;

try {
  if (cmd === 'eval') console.log(JSON.stringify(await run(a)));
  else if (cmd === 'click') await run(`${need(a)}.click()`);
  else if (cmd === 'fill') {
    await run(`(() => { const e = ${need(a)}; e.value = ${JSON.stringify(b)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  } else if (cmd === 'key') {
    await run(`${need(a)}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(b)}, bubbles: true }))`);
  } else if (cmd === 'wait') {
    const end = Date.now() + Number(b || 15000);
    while (!(await run(`!!(${a})`).catch(() => false))) {
      if (Date.now() > end) fail(`timed out waiting for: ${a}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  } else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(a), { recursive: true });
    writeFileSync(a, Buffer.from(r.result.data, 'base64'));
  } else fail('usage: targets | eval | wait | click | fill | key | shot');
} catch (e) {
  fail(e.message);
}
process.exit(0);
