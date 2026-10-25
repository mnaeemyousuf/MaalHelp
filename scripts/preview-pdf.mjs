// Renders PDF pages to PNG contact sheets for visual checks (uses pdf.js inside headless Chrome).
// Usage: node scripts/preview-pdf.mjs docs/user-manuals/Auditor_User_Manual.pdf [firstPage] [count]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [file, first = '1', count = '6'] = process.argv.slice(2);
const out = resolve('.data/pdf-preview');
mkdirSync(out, { recursive: true });
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p));
const pdfjs = pathToFileURL(resolve('node_modules/pdfjs-dist/build/pdf.min.mjs')).href;
const worker = pathToFileURL(resolve('node_modules/pdfjs-dist/build/pdf.worker.min.mjs')).href;
const data = readFileSync(resolve(file)).toString('base64');
const html = resolve(out, 'viewer.html');
writeFileSync(html, `<!doctype html><body style="margin:0;background:#cbd5e1;display:flex;flex-wrap:wrap;gap:12px;padding:12px;width:1300px" id="b"><script type="module">
import * as pdfjs from '${pdfjs}'; pdfjs.GlobalWorkerOptions.workerSrc = '${worker}';
const doc = await pdfjs.getDocument({ data: Uint8Array.from(atob('${data}'), c => c.charCodeAt(0)) }).promise;
const from = ${Number(first)}, to = Math.min(doc.numPages, from + ${Number(count)} - 1);
for (let n = from; n <= to; n++) { const p = await doc.getPage(n); const v = p.getViewport({ scale: ${Number(process.env.SCALE || 0.68)} }); const c = document.createElement('canvas'); c.width = v.width; c.height = v.height; c.style.background='#fff'; document.getElementById('b').append(c); await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; }
document.title = 'done:' + doc.numPages;
</script></body>`);
const b = await chromium.launch({ executablePath: exe, args: ['--allow-file-access-from-files'] });
const page = await b.newPage({ viewport: { width: 1324, height: 900 } });
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => document.title.startsWith('done'), null, { timeout: 60000 });
const png = resolve(out, `${basename(file, '.pdf')}-p${first}.png`);
await page.screenshot({ path: png, fullPage: true });
console.log(png, await page.title());
await b.close();
