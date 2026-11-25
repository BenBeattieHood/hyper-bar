import { chromium, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extensionPath, withUserDataDir } from './helpers/extension';

test('probe discard over raw cdp', () => withUserDataDir('probe-cdp', async (dir) => {
  const proc = spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let port: string | undefined;
  for (let i = 0; i < 100 && !port; i++) { await sleep(100); const f = join(dir, 'DevToolsActivePort'); if (existsSync(f)) port = readFileSync(f, 'utf8').split('\n')[0]; }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map<number, (d: any) => void>();
  ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id) pending.get(d.id)?.(d); };
  const send = (method: string, params = {}, sessionId?: string) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  let sw: any;
  for (let i = 0; i < 50 && !sw; i++) { const { result } = await send('Target.getTargets'); sw = result.targetInfos.find((t: any) => t.type === 'service_worker' && t.url.endsWith('/background.js')); if (!sw) await sleep(200); }
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const evaluate = async (expression: string) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); return r.result?.result?.value ?? r; };
  console.log('PROBE', JSON.stringify(await evaluate(`(async () => { const a = await chrome.tabs.create({ url: 'https://example.com/', active: false }); await chrome.tabs.create({ url: 'about:blank', active: true }); await new Promise(r => setTimeout(r, 2000)); const d = await chrome.tabs.discard(a.id); return [a.id, d.id]; })()`)));
  await sleep(1500);
  console.log('PROBE alive', proc.exitCode, JSON.stringify(await evaluate(`chrome.tabs.query({}).then(t => t.map(x => [x.id, x.discarded, x.url]))`)));
  proc.kill();
}));
