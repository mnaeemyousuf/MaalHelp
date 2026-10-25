// Builds the role-wise Maal Help user manuals (PDF) from scripts/manual-content.mjs and real screenshots.
// Usage: node scripts/build-manuals.mjs            (all manuals + index)
//        node scripts/build-manuals.mjs Auditor    (manuals whose file name contains "Auditor")
// Requires a local Chrome or Edge (headless) and the screenshots in docs/user-manuals/screenshots.
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { T, ROLES, GLOSSARY, COMMON_FAQ, COMMON_TROUBLE, VERSION, DATE } from './manual-content.mjs';

const OUT = resolve('docs/user-manuals');
const SHOTS = resolve(OUT, 'screenshots');
const BUILD = resolve('.data/manual-build');
mkdirSync(BUILD, { recursive: true });
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
if (!exe) throw new Error('Chrome or Edge is required');

const BRAND = { blue: '#1f37b0', blueDark: '#1e2e6f', blueLight: '#eef3ff', amber: '#f59e0b', ink: '#0f172a', muted: '#64748b' };
const logoSvg = readFileSync(resolve('web/public/brand/logo-mark.svg'), 'utf8');
const logoData = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/`(.+?)`/g, '<code>$1</code>');
const shotUrl = (name) => {
  const p = resolve(SHOTS, `${name}.png`);
  if (!existsSync(p)) throw new Error(`Missing screenshot: ${name}.png`);
  return pathToFileURL(p).href;
};
const PHONE = (n) => /^(mobile-|operator-mobile|receiving-mobile|picker-mobile|dispatch-mobile|owner-mobile)/.test(n);
let figNo = 0;
const figure = (name, caption) => `<figure class="${PHONE(name) ? 'phone' : ''}"><img src="${shotUrl(name)}"><figcaption>Figure ${++figNo}. ${md(caption)}</figcaption></figure>`;

const CSS = `
@page { size: A4; margin: 22mm 16mm 20mm 16mm; }
* { box-sizing: border-box; }
body { font-family: 'Segoe UI', Inter, Arial, sans-serif; color: ${BRAND.ink}; font-size: 10.5pt; line-height: 1.5; margin: 0; }
h1 { font-size: 22pt; color: ${BRAND.blueDark}; margin: 0 0 4mm; letter-spacing: -0.3px; }
h1 .num { color: ${BRAND.amber}; margin-right: 3mm; }
h2 { font-size: 13.5pt; color: ${BRAND.blue}; margin: 7mm 0 2mm; break-after: avoid; }
h3 { font-size: 11pt; margin: 4mm 0 1mm; break-after: avoid; }
.chapter { break-before: page; }
.keep { break-inside: avoid; }
.phones { display: flex; justify-content: center; gap: 8mm; }
.phones figure { width: 64mm; margin-top: 2mm; }
.phones figure img { max-height: 112mm; }
.chapter:first-child { break-before: auto; }
.lead { color: ${BRAND.muted}; font-size: 11pt; margin-bottom: 4mm; }
ol, ul { margin: 1mm 0 3mm; padding-left: 6mm; }
li { margin: 0.8mm 0; }
figure { margin: 3mm 0 5mm; break-inside: avoid; text-align: center; }
figure img { max-width: 100%; max-height: 118mm; border: 1px solid #dbe2f0; border-radius: 2mm; box-shadow: 0 1mm 3mm rgba(15,23,42,.08); }
figure.phone img { max-height: 125mm; max-width: 62mm; border-radius: 4mm; }
figcaption { font-size: 8.5pt; color: ${BRAND.muted}; margin-top: 1.5mm; }
.note { background: ${BRAND.blueLight}; border-left: 1.2mm solid ${BRAND.blue}; padding: 2.5mm 4mm; border-radius: 1mm; margin: 2mm 0 4mm; break-inside: avoid; font-size: 9.5pt; }
.note.warn { background: #fff7e6; border-left-color: ${BRAND.amber}; }
table { width: 100%; border-collapse: collapse; margin: 2mm 0 5mm; font-size: 9.5pt; break-inside: auto; }
th { background: ${BRAND.blue}; color: #fff; text-align: left; padding: 2mm 3mm; font-weight: 600; }
td { padding: 2mm 3mm; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
tr { break-inside: avoid; }
tr:nth-child(even) td { background: #f8fafc; }
code { font-family: Consolas, monospace; font-size: 9pt; background: #f1f5f9; padding: 0 1mm; border-radius: 1mm; }
.toc { width: 100%; }
.toc td { border: none; padding: 1.4mm 0; background: none !important; }
.toc td.p { text-align: right; width: 14mm; font-variant-numeric: tabular-nums; }
.toc td.t { border-bottom: 1px dotted #cbd5e1; }
.toc tr.sub td { font-size: 9pt; color: ${BRAND.muted}; padding: 0.6mm 0 0.6mm 6mm; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; }
.card { border: 1px solid #dbe2f0; border-radius: 2mm; padding: 3mm 4mm; break-inside: avoid; }
.card h3 { margin-top: 0; }
.ok li::marker { content: '✔  '; color: #059669; } .no li::marker { content: '✘  '; color: #dc2626; }
.steps { counter-reset: s; list-style: none; padding-left: 0; }
.steps > li { counter-increment: s; position: relative; padding-left: 9mm; margin: 1.6mm 0; }
.steps > li::before { content: counter(s); position: absolute; left: 0; top: 0.2mm; width: 6mm; height: 6mm; border-radius: 50%; background: ${BRAND.blue}; color: #fff; font-size: 8.5pt; font-weight: 700; text-align: center; line-height: 6mm; }
`;

function htmlDoc(body) { return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`; }

function coverHtml(r) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; } body { margin: 0; font-family: 'Segoe UI', Inter, Arial, sans-serif; }
  .c { width: 210mm; height: 297mm; background: linear-gradient(160deg, ${BRAND.blueDark} 0%, ${BRAND.blue} 60%, #2647d8 100%); color: #fff; position: relative; overflow: hidden; }
  .c .crate { position: absolute; right: -30mm; bottom: -30mm; width: 150mm; height: 150mm; border-radius: 22mm; background: rgba(245,158,11,.18); transform: rotate(18deg); }
  .c .top { padding: 28mm 22mm 0; display: flex; align-items: center; gap: 6mm; }
  .c .top img { width: 22mm; height: 22mm; }
  .c .word { font-size: 30pt; font-weight: 800; letter-spacing: -0.5px; } .c .word span { color: ${BRAND.amber}; }
  .c .tag { font-size: 12pt; opacity: .85; margin-top: 1mm; }
  .c .main { position: absolute; left: 22mm; right: 22mm; top: 105mm; }
  .c .kicker { text-transform: uppercase; letter-spacing: 2px; font-size: 10pt; color: ${BRAND.amber}; font-weight: 700; }
  .c h1 { font-size: 40pt; margin: 4mm 0 2mm; line-height: 1.05; }
  .c .sub { font-size: 14pt; opacity: .9; max-width: 140mm; }
  .c .foot { position: absolute; left: 22mm; bottom: 20mm; font-size: 10pt; opacity: .85; line-height: 1.6; }
  </style></head><body><div class="c"><div class="crate"></div>
  <div class="top"><img src="${logoData}" style="border-radius:22%;box-shadow:0 0 0 1px rgba(255,255,255,.25)"><div><div class="word">Maal <span>Help</span></div><div class="tag">Your Warehouse. Under Control.</div></div></div>
  <div class="main"><div class="kicker">User manual</div><h1>${esc(r.title)}</h1><div class="sub">${esc(r.coverSub ?? r.purpose)}</div></div>
  <div class="foot">Version ${VERSION} · ${DATE}<br>For Maal Help ${VERSION}</div></div></body></html>`;
}

const headerTpl = (title) => `<div style="width:100%;font-size:7.5pt;font-family:Segoe UI,Arial;color:#64748b;padding:0 16mm;display:flex;justify-content:space-between;align-items:center;">
  <span style="display:flex;align-items:center;gap:6px;"><img src="${logoData}" style="width:13px;height:13px;"><b style="color:${BRAND.blueDark}">Maal Help</b>&nbsp;·&nbsp;${esc(title)} User Manual</span>
  <span>Your Warehouse. Under Control.</span></div>`;
const footerTpl = `<div style="width:100%;font-size:7.5pt;font-family:Segoe UI,Arial;color:#64748b;padding:0 16mm;display:flex;justify-content:space-between;border-top:0.5px solid #e2e8f0;padding-top:2mm;">
  <span>Version ${VERSION} · ${DATE} · Fictional demo data shown</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

/** Chapters for a role manual: [{ title, subs: [..], html }] */
function chapters(r) {
  figNo = 0;
  const ch = [];
  ch.push({ title: 'Introduction', subs: ['Who this manual is for', 'What you can and cannot do'], html: `
    <h2>Who this manual is for</h2><p>This manual is for people with the <b>${esc(r.role)}</b> role in Maal Help. ${md(r.purpose)}</p>
    <p>Maal Help is a warehouse operating system: stock by warehouse, location, batch and owner on a permanent ledger, plus purchasing, sales and fulfilment, billing, reports and an AI Copilot that answers from your own data.</p>
    <div class="grid2"><div class="card ok"><h3>Your role can</h3><ul>${r.can.map((x) => `<li>${md(x)}</li>`).join('')}</ul></div>
    <div class="card no"><h3>Your role cannot</h3><ul>${r.cannot.map((x) => `<li>${md(x)}</li>`).join('')}</ul></div></div>
    <div class="note">Screens show the fictional demo company <b>ABC Trading &amp; Warehousing</b>. Your company’s names and numbers will differ. Menus show only what your role is allowed to use.</div>` });
  const access = r.file.startsWith('Super') ? ['signin'] : ['signin', 'navigation', ...(['operator', 'receiving', 'picker', 'dispatch'].some((k) => r.account.startsWith(k)) ? ['mobileHome'] : [])];
  ch.push({ title: 'Access and navigation', subs: access.map((k) => T[k].title), html: access.map(topicHtml).join('') });
  ch.push({ title: r.file.startsWith('Super') ? 'Platform overview' : 'Your home screen', subs: [], html: `
    ${figure(r.dashboard[0], r.dashboard[1])}
    <ul>${r.dashboardText.map((x) => `<li>${md(x)}</li>`).join('')}</ul>
` });
  ch.push({ title: 'Features step by step', subs: r.topics.map((k) => T[k].title), html: r.topics.map(topicHtml).join('') });
  ch.push({ title: 'End-to-end workflows', subs: r.workflows.map((w) => w[0]), html: r.workflows.map(([t, s]) => `<h2>${esc(t)}</h2><ol class="steps">${s.map((x) => `<li>${md(x)}</li>`).join('')}</ol>`).join('') });
  ch.push({ title: 'Reports, notifications and exceptions', subs: ['Reports and exports', 'Notifications and alerts', 'When something is refused'], html: `
    <h2>Reports and exports</h2><p>${r.reports.map(md).join(' ')}</p>${r.file.startsWith('Super') ? '' : '<p>Open <b>Reports</b>, choose a report, set filters and export to Excel, CSV or PDF, or print. You see only the reports your role may view.</p>'}
    <h2>Notifications and alerts</h2><p>${r.alertsText.map(md).join(' ')}</p><p>The bell at the top right lists new notifications. In-app alerts are always on; email and WhatsApp alerts depend on your company’s settings.</p>
    <h2>When something is refused</h2>
    <table><tr><th>Message</th><th>Meaning</th><th>What to do</th></tr>
    <tr><td>Insufficient stock</td><td>Not enough <i>available</i> units at that place</td><td>Check reserved, quarantine or dock stock; choose another location or wait</td></tr>
    <tr><td>Wrong location / wrong product</td><td>The scan does not match the task</td><td>Go to the right place or item and scan again</td></tr>
    <tr><td>Quantity exceeds the task</td><td>More than required</td><td>Enter the task quantity</td></tr>
    <tr><td>Pending approval</td><td>Above the company threshold</td><td>An approver must approve; nothing is posted yet</td></tr>
    <tr><td>You don’t have permission</td><td>Your role lacks the action</td><td>Ask your administrator</td></tr>
    <tr><td>Credit limit exceeded</td><td>Customer balance too high</td><td>Collect payment or ask the owner</td></tr></table>` });
  const faq = [...r.faq, ...COMMON_FAQ];
  const trouble = r.trouble === COMMON_TROUBLE ? COMMON_TROUBLE : [...r.trouble, ...COMMON_TROUBLE.slice(0, 2)];
  ch.push({ title: 'FAQ and troubleshooting', subs: ['Frequently asked questions', 'Troubleshooting'], html: `
    <h2>Frequently asked questions</h2>${faq.map(([q, a]) => `<h3>${md(q)}</h3><p>${md(a)}</p>`).join('')}
    <h2>Troubleshooting</h2><table><tr><th style="width:40%">Problem</th><th>Solution</th></tr>${trouble.map(([p, s]) => `<tr><td>${md(p)}</td><td>${md(s)}</td></tr>`).join('')}</table>
    <div class="note">Still stuck? Note the screen, the record number (for example SO-10245) and the exact message, and contact your company administrator.</div>` });
  ch.push({ title: 'Glossary and quick reference', subs: ['Quick reference', 'Glossary'], html: `
    <h2>Quick reference</h2><table><tr><th style="width:45%">I want to…</th><th>Go to</th></tr>${r.quick.map(([a, b]) => `<tr><td>${md(a)}</td><td><b>${md(b)}</b></td></tr>`).join('')}
    <tr><td>Search anything</td><td><b>Ctrl + K</b></td></tr></table>
    <h2>Glossary</h2><table><tr><th style="width:30%">Term</th><th>Meaning</th></tr>${GLOSSARY.map(([a, b]) => `<tr><td><b>${esc(a)}</b></td><td>${esc(b)}</td></tr>`).join('')}</table>` });
  return ch;
}

function topicHtml(k) {
  const t = T[k];
  if (!t) throw new Error(`Unknown topic ${k}`);
  const shots = t.shots ?? [];
  const phones = shots.length > 0 && shots.every(([n]) => PHONE(n));
  const [firstShot, ...rest] = shots;
  const visuals = phones ? `<div class="phones">${shots.map(([n, c]) => figure(n, c)).join('')}</div>` : (firstShot ? figure(...firstShot) : '');
  return `<div class="keep"><h2>${esc(t.title)}</h2><p class="lead">${md(t.intro)}</p>${visuals}</div>${phones ? '' : rest.map(([n, c]) => figure(n, c)).join('')}
    <ol class="steps">${t.steps.map((s) => `<li>${md(s)}</li>`).join('')}</ol>${(t.notes ?? []).map((n) => `<div class="note">${md(n)}</div>`).join('')}`;
}

function frontHtml(r, toc) {
  return `<div class="chapter"><h1>About this manual</h1>
    <table><tr><th style="width:35%">Item</th><th>Details</th></tr>
    <tr><td>Product</td><td>Maal Help ${VERSION}: <i>Your Warehouse. Under Control.</i></td></tr>
    <tr><td>Manual</td><td>${esc(r.title)} User Manual</td></tr><tr><td>Role in the system</td><td>${esc(r.role)}</td></tr>
    <tr><td>Version / date</td><td>${VERSION} · ${DATE}</td></tr>
    <tr><td>Screenshots</td><td>Captured from the running application with the fictional demo company “ABC Trading &amp; Warehousing”</td></tr>
    <tr><td>Demo account for this role</td><td><code>${esc(r.account)}</code>. Development/demo environment only. The password is provided by your administrator and is never printed in manuals.</td></tr></table>
    <h2>Contents</h2><table class="toc">${toc.map((c, i) => `<tr><td class="t"><b>${i + 1}. ${esc(c.title)}</b></td><td class="p">${c.page ?? '00'}</td></tr>${c.subs.length ? `<tr class="sub"><td colspan="2">${c.subs.map(esc).join(' · ')}</td></tr>` : ''}`).join('')}</table></div>`;
}

const chapterHtml = (c, i) => `<div class="chapter"><h1><span class="num">${i + 1}</span>${esc(c.title)}</h1>${c.html}</div>`;

async function renderPdf(page, html, file, title, withChrome = true) {
  const path = resolve(BUILD, 'tmp.html');
  writeFileSync(path, html);
  await page.goto(pathToFileURL(path).href, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))));
  return page.pdf({ path: file, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: withChrome, headerTemplate: withChrome ? headerTpl(title) : '<span></span>', footerTemplate: withChrome ? footerTpl : '<span></span>' });
}
const pages = async (buf) => (await PDFDocument.load(buf)).getPageCount();

async function buildManual(page, r) {
  const ch = chapters(r);
  // Pass 1: measure each part separately (every chapter starts on a new page, so counts add up).
  const front = await pages(await renderPdf(page, htmlDoc(frontHtml(r, ch)), resolve(BUILD, 'm.pdf'), r.title));
  let at = front + 1;
  for (const [i, c] of ch.entries()) {
    figNo = 0; // figure numbers do not change page count
    c.page = at;
    at += await pages(await renderPdf(page, htmlDoc(chapterHtml(c, i)), resolve(BUILD, 'm.pdf'), r.title));
  }
  // Pass 2: render the body in one go with the real page numbers, then prepend the cover.
  const fresh = chapters(r).map((c, i) => ({ ...c, page: ch[i].page }));
  const body = await renderPdf(page, htmlDoc(frontHtml(r, fresh) + fresh.map(chapterHtml).join('')), resolve(BUILD, 'body.pdf'), r.title);
  const cover = await renderPdf(page, coverHtml(r), resolve(BUILD, 'cover.pdf'), r.title, false);
  const out = await PDFDocument.create();
  for (const src of [cover, body]) {
    const doc = await PDFDocument.load(src);
    for (const p of await out.copyPages(doc, doc.getPageIndices())) out.addPage(p);
  }
  out.setTitle(`Maal Help: ${r.title} User Manual`); out.setAuthor('Maal Help'); out.setSubject('Your Warehouse. Under Control.'); out.setCreator('scripts/build-manuals.mjs');
  const bytes = await out.save();
  writeFileSync(resolve(OUT, r.file), bytes);
  const total = out.getPageCount();
  const bodyPages = await pages(body);
  if (bodyPages !== at - 1) console.warn(`  ! ${r.file}: TOC expected ${at - 1} body pages, got ${bodyPages}`);
  console.log(`ok ${r.file} (${total} pages incl. cover)`);
  return { file: r.file, title: r.title, role: r.role, pages: total };
}

async function buildIndex(page, built) {
  const r = { title: 'User Manual Index', role: 'All roles', purpose: 'Which manual to read, and how to get started with Maal Help.', coverSub: 'Which manual to read, and how to get started with Maal Help.' };
  figNo = 0;
  const body = `<div class="chapter"><h1>Maal Help user manuals</h1>
    <p class="lead">Maal Help has one manual per role. Read the one that matches the role your administrator gave you (shown under your name at the bottom of the sidebar).</p>
    <table><tr><th>Manual (file)</th><th>Role in the system</th><th>Read it if you…</th><th>Pages</th></tr>
    ${built.map((b) => { const def = ROLES.find((x) => x.file === b.file); return `<tr><td><b>${esc(b.title)}</b><br><code>${esc(b.file)}</code></td><td>${esc(b.role)}</td><td>${md(def.purpose.split('.')[0])}.</td><td>${b.pages}</td></tr>`; }).join('')}</table>
    <div class="note">The role list matches the permission catalogue enforced by the server (see <code>docs/ROLE_PERMISSION_MATRIX.md</code>). The Warehouse Operator manual covers all floor tasks; the Receiving Clerk, Picker/Packer and Dispatch Officer manuals cover the same screens limited to that job.</div></div>
    <div class="chapter"><h1>Getting started in five minutes</h1>
    ${figure('login', 'Sign in with the email and password your administrator gave you.')}
    <ol class="steps"><li>Sign in. Floor roles open the mobile task app; everyone else opens the dashboard.</li><li>Change your temporary password: <b>Settings → My profile</b>.</li><li>Press <b>Ctrl + K</b> to find anything.</li><li>Look at <b>Alerts</b> and, if you have it, <b>Approvals</b>.</li><li>Open your role manual for step-by-step instructions.</li></ol>
    ${figure('owner-dashboard', 'The owner command center.')}
    ${figure('operator-mobile-home', 'The mobile task app for floor staff.')}</div>`;
  const html = htmlDoc(body);
  const bodyPdf = await renderPdf(page, html, resolve(BUILD, 'body.pdf'), 'Index');
  const cover = await renderPdf(page, coverHtml(r), resolve(BUILD, 'cover.pdf'), 'Index', false);
  const out = await PDFDocument.create();
  for (const src of [cover, bodyPdf]) { const doc = await PDFDocument.load(src); for (const p of await out.copyPages(doc, doc.getPageIndices())) out.addPage(p); }
  out.setTitle('Maal Help: User Manual Index'); out.setAuthor('Maal Help');
  writeFileSync(resolve(OUT, 'USER_MANUAL_INDEX.pdf'), await out.save());
  console.log(`ok USER_MANUAL_INDEX.pdf (${out.getPageCount()} pages)`);
}

const filter = process.argv[2];
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
const built = [];
for (const r of ROLES) {
  if (filter && !r.file.includes(filter)) continue;
  built.push(await buildManual(page, r));
}
if (!filter) {
  await buildIndex(page, built);
  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify({ version: VERSION, date: DATE, manuals: built }, null, 2));
}
await browser.close();
