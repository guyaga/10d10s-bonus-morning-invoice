#!/usr/bin/env node
// morning.mjs - Morning (Green Invoice) CLI for Claude Code.
// Reads are free. Every write (document, client, close, email) is a draft first and runs only
// through `execute <draftId>` after the user approved that exact draft.
// No dependencies: Node 18+ (global fetch).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const HOME = process.env.MORNING_HOME || path.join(os.homedir(), '.morning-invoice');
const DRAFT_DIR = path.join(HOME, 'drafts');
const APPROVAL_DIR = path.join(HOME, 'approvals');
const PREVIEW_DIR = path.join(HOME, 'previews');
const CRED_FILE = path.join(HOME, 'credentials.txt');
const LEDGER = path.join(HOME, 'ledger.jsonl');
const TTL_MS = 30 * 60 * 1000;
const HOSTS = {
  production: 'https://api.greeninvoice.co.il/api/v1',
  sandbox: 'https://sandbox.d.greeninvoice.co.il/api/v1',
};
const VAT_RATE = Number(process.env.MORNING_VAT_RATE || 0.18);
const LARGE_AMOUNT = 50000;

const TYPES = {
  10: 'הצעת מחיר · Price Quote', 100: 'הזמנה · Order', 200: 'תעודת משלוח · Delivery Note',
  210: 'תעודת החזרה · Return Note', 300: 'חשבון עסקה · Transaction Invoice', 305: 'חשבונית מס · Tax Invoice',
  320: 'חשבונית מס / קבלה · Tax Invoice / Receipt', 330: 'חשבונית זיכוי · Credit Invoice',
  400: 'קבלה · Receipt', 405: 'קבלה על תרומה · Donation Receipt', 500: 'הזמנת רכש · Purchase Order',
};
const NEEDS_PAYMENT = new Set([320, 400, 405]);
const NO_PAYMENT = new Set([10, 100, 200, 210, 300, 305, 330, 500]);
const PAYMENT_TYPES = { 0: 'Tax deduction', 1: 'Cash', 2: 'Cheque', 3: 'Credit card', 4: 'Wire transfer', 5: 'PayPal', 10: 'Payment app (Bit/Pay)', 11: 'Other' };

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const die = (msg, code = 1) => { console.error('ERROR: ' + msg); process.exit(code); };
const ensureDirs = () => [DRAFT_DIR, APPROVAL_DIR, PREVIEW_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
const todayIL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const money = (n, cur = 'ILS') => `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
const round2 = n => Math.round(n * 100) / 100;
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { die(`Cannot read JSON ${file}: ${e.message}`); }
}

// ---------- credentials ----------
function winUserEnv(name) {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\r?$`, 'm'));
    return m ? m[1] : undefined;
  } catch { return undefined; }
}

function readCredFile() {
  if (!fs.existsSync(CRED_FILE)) return {};
  const out = {};
  for (const line of fs.readFileSync(CRED_FILE, 'utf8').replace(/^﻿/, '').split('\n')) {
    const l = line.replace(/\r$/, '');
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1); // value kept verbatim, no quoting
  }
  return out;
}

function loadCreds() {
  const file = readCredFile();
  const pick = name => {
    if (process.env[name]) return [process.env[name], 'environment'];
    if (file[name]) return [file[name], 'credentials file'];
    const w = winUserEnv(name);
    if (w) return [w, 'Windows user environment'];
    return [undefined, null];
  };
  const [keyId, src1] = pick('MORNING_API_KEY_ID');
  const [secret, src2] = pick('MORNING_API_SECRET');
  const env = (process.env.MORNING_ENV || file.MORNING_ENV || winUserEnv('MORNING_ENV') || 'production').trim().toLowerCase();
  if (!keyId || !secret || /PASTE_/.test(keyId + secret)) {
    die(`No Morning API credentials. Run \`node morning.mjs setup\` and paste your key into ${CRED_FILE}, ` +
        'or set MORNING_API_KEY_ID and MORNING_API_SECRET as user environment variables.');
  }
  if (!HOSTS[env]) die(`MORNING_ENV must be "production" or "sandbox" (got "${env}").`);
  return { keyId: keyId.trim(), secret, env, source: src1 === src2 ? src1 : `${src1} + ${src2}` };
}

// ---------- API ----------
let CREDS, TOKEN;
function redact(s) { return CREDS ? String(s).split(CREDS.secret).join('***') : String(s); }

async function raw(method, p, body, auth = true) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(HOSTS[CREDS.env] + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + TOKEN } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  die('Rate limited by Morning (429) four times in a row. Wait a minute and retry.');
}

async function api(method, p, body, { soft = false } = {}) {
  if (!CREDS) CREDS = loadCreds();
  if (!TOKEN) {
    const r = await raw('POST', '/account/token', { id: CREDS.keyId, secret: CREDS.secret }, false);
    if (r.status !== 200 || !r.data.token) die(`Authentication failed (${r.status}): ${redact(JSON.stringify(r.data))}`);
    TOKEN = r.data.token;
  }
  await sleep(350); // ~3 req/s limit
  const r = await raw(method, p, body);
  if (r.status >= 400) {
    const msg = `${method} ${p} -> ${r.status}: ${redact(JSON.stringify(r.data))}`;
    if (soft) throw new Error(msg);
    die(msg);
  }
  return r.data;
}

// ---------- documents: normalize + validate ----------
function normalizeDoc(d) {
  const doc = JSON.parse(JSON.stringify(d));
  doc.type = Number(doc.type ?? 320);
  doc.lang ??= 'he';
  doc.currency ??= 'ILS';
  doc.vatType ??= 0;
  doc.date ??= todayIL();
  if (doc.client && !doc.client.id) {
    doc.client.country ??= 'IL';
    doc.client.add ??= true;
    if (typeof doc.client.emails === 'string') doc.client.emails = [doc.client.emails];
  }
  doc.income = (doc.income || []).map(r => ({ quantity: 1, currency: doc.currency, vatType: 1, ...r }));
  doc.payment = (doc.payment || []).map(p => ({ currency: doc.currency, date: doc.date, ...p }));
  if (!doc.payment.length) delete doc.payment;
  return doc;
}

function totals(doc) {
  let net = 0, gross = 0, exact = true;
  for (const r of doc.income || []) {
    const line = Number(r.quantity) * Number(r.price);
    if (doc.vatType === 1 || r.vatType === 2) { net += line; gross += line; }
    else if (r.vatType === 1) { gross += line; net += line / (1 + VAT_RATE); }
    else { net += line; gross += line * (1 + VAT_RATE); exact = false; }
  }
  const paid = (doc.payment || []).reduce((s, p) => s + Number(p.price), 0);
  return { net: round2(net), gross: round2(gross), vat: round2(gross - net), paid: round2(paid), exact };
}

function validateDoc(doc) {
  const errors = [], warnings = [];
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!TYPES[doc.type]) errors.push(`Unknown document type ${doc.type}.`);
  if (!['he', 'en'].includes(doc.lang)) errors.push('lang must be "he" or "en".');
  if (![0, 1, 2].includes(doc.vatType)) errors.push('Document vatType must be 0, 1 or 2.');
  if (!re.test(doc.date)) errors.push(`date must be YYYY-MM-DD (got ${doc.date}).`);
  if (doc.dueDate && !re.test(doc.dueDate)) errors.push('dueDate must be YYYY-MM-DD.');
  if (!doc.client || (!doc.client.id && !doc.client.name)) errors.push('client needs an existing id or a name.');
  if (![400, 405].includes(doc.type) && !doc.income.length) errors.push('At least one income row is required.');
  for (const [i, r] of doc.income.entries()) {
    if (!r.description) errors.push(`Income row ${i + 1} has no description.`);
    if (!(Number(r.price) > 0)) errors.push(`Income row ${i + 1}: price must be a positive number.`);
    if (!(Number(r.quantity) > 0)) errors.push(`Income row ${i + 1}: quantity must be a positive number.`);
  }
  const hasPay = !!(doc.payment && doc.payment.length);
  if (NEEDS_PAYMENT.has(doc.type) && !hasPay) errors.push(`Type ${doc.type} needs payment rows (how and when it was paid).`);
  if (NO_PAYMENT.has(doc.type) && hasPay) errors.push(`Type ${doc.type} must not have payment rows.`);
  for (const p of doc.payment || []) {
    if (!(p.type in PAYMENT_TYPES)) errors.push(`Unknown payment type ${p.type}.`);
    if (!(Number(p.price) > 0)) errors.push('Payment rows need a positive price.');
  }
  const t = totals(doc);
  if (hasPay && doc.income.length && Math.abs(t.paid - t.gross) > 0.01) {
    const msg = `Payments (${money(t.paid, doc.currency)}) do not equal the document total (${money(t.gross, doc.currency)}).`;
    if (t.exact) errors.push(msg); else warnings.push(msg + ` Total assumes ${VAT_RATE * 100}% VAT.`);
  }
  const ageDays = (Date.parse(todayIL()) - Date.parse(doc.date)) / 86400000;
  if (doc.type === 300 && ageDays > 1) errors.push('Morning does not allow backdating a חשבון עסקה (300) more than about a day. Use today\'s date.');
  if (ageDays < 0) warnings.push(`The date ${doc.date} is in the future.`);
  if (t.gross > LARGE_AMOUNT) warnings.push(`Large amount: ${money(t.gross, doc.currency)}. Double-check the price and quantity.`);
  for (const e of doc.client?.emails || []) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) warnings.push(`Email "${e}" looks invalid.`);
  return { errors, warnings, totals: t };
}

function docLines(doc, t) {
  const vatNote = doc.vatType === 1 ? 'VAT exempt'
    : doc.income.every(r => r.vatType === 1) ? 'prices include VAT'
    : doc.income.every(r => r.vatType === 0) ? 'VAT added on top' : 'mixed VAT';
  const lines = [
    `${TYPES[doc.type]} (${doc.type})  ·  date ${doc.date}${doc.dueDate ? `  ·  due ${doc.dueDate}` : ''}  ·  ${doc.lang}`,
    `Client: ${doc.client.id ? `existing client ${doc.client.name || ''} [${doc.client.id}]` : `${doc.client.name} (NEW, will be saved to clients)`}` +
      (doc.client.taxId ? `  ·  ח.פ ${doc.client.taxId}` : '') + (doc.client.emails?.length ? `  ·  ${doc.client.emails.join(', ')}` : ''),
  ];
  if (doc.client.address || doc.client.city) lines.push(`Address: ${[doc.client.address, doc.client.city].filter(Boolean).join(', ')}`);
  for (const r of doc.income) lines.push(`  • ${r.description}  ·  ${r.quantity} × ${money(r.price, r.currency)}`);
  lines.push(`Total: ${money(t.gross, doc.currency)}  (before VAT ${money(t.net, doc.currency)}, VAT ${money(t.vat, doc.currency)}; ${vatNote})`);
  for (const p of doc.payment || []) lines.push(`  paid: ${PAYMENT_TYPES[p.type]} ${money(p.price, p.currency)} on ${p.date}`);
  if (doc.linkedDocumentIds?.length) lines.push(`Links and closes: ${doc.linkedDocumentIds.join(', ')}`);
  if (doc.remarks) lines.push(`Remarks: ${doc.remarks}`);
  return lines;
}

async function recentDuplicates(doc, t) {
  try {
    const from = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const res = await api('POST', '/documents/search', { page: 1, pageSize: 100, fromDate: from, sort: 'documentDate', sortType: 'desc' }, { soft: true });
    const name = (doc.client.name || '').trim().toLowerCase();
    return (res.items || []).filter(it =>
      it.type === doc.type && Math.abs(Number(it.amount) - t.gross) < 1 &&
      ((doc.client.id && it.client?.id === doc.client.id) || (name && (it.client?.name || '').trim().toLowerCase() === name)));
  } catch { return []; }
}

// ---------- drafts ----------
function newDraft(action, items, summary, warnings) {
  ensureDirs();
  const id = crypto.randomBytes(3).toString('hex');
  const draft = { id, action, env: CREDS.env, created: Date.now(), items, summary, warnings };
  fs.writeFileSync(path.join(DRAFT_DIR, id + '.json'), JSON.stringify(draft, null, 2));
  return draft;
}

function loadDraft(id) {
  const f = path.join(DRAFT_DIR, id + '.json');
  if (!/^[0-9a-f]{6}$/.test(id || '') || !fs.existsSync(f)) die(`Draft ${id} not found (it may have run already or been discarded).`);
  const buf = fs.readFileSync(f);
  return { draft: JSON.parse(buf.toString('utf8')), file: f, hash: sha256(buf) };
}

function guardActive() {
  try { return fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8').includes('morning-guard'); }
  catch { return false; }
}

function printDraft(d) {
  console.log(`\nDRAFT ${d.id}  ·  ${d.action}  ·  ${d.env.toUpperCase()}${d.env === 'production' ? ' (real documents)' : ' (test account)'}`);
  console.log('─'.repeat(60));
  for (const l of d.summary) console.log(l);
  if (d.warnings.length) { console.log('\nWARNINGS:'); d.warnings.forEach(w => console.log('  ! ' + w)); }
  console.log('─'.repeat(60));
  console.log(`Nothing has been sent to Morning. Show this to the user and wait for an explicit approval of draft ${d.id}.`);
  console.log(`Then run: node morning.mjs execute ${d.id}${guardActive() ? '' : ' --yes'}`);
}

async function previewPdf(doc, label) {
  ensureDirs();
  const r = await api('POST', '/documents/preview', doc);
  if (!r.file) return null;
  const out = path.join(PREVIEW_DIR, `${label}.pdf`);
  fs.writeFileSync(out, Buffer.from(r.file, 'base64'));
  return out;
}

async function draftCreate(file, flags) {
  const input = readJson(file);
  const docs = (Array.isArray(input) ? input : [input]).map(normalizeDoc);
  const summary = [], warnings = [];
  let fatal = false;
  const label = crypto.randomBytes(3).toString('hex');
  for (const [i, doc] of docs.entries()) {
    const { errors, warnings: w, totals: t } = validateDoc(doc);
    if (docs.length > 1) summary.push(`\n#${i + 1}`);
    summary.push(...docLines(doc, t));
    errors.forEach(e => { fatal = true; summary.push('  ✗ ' + e); });
    w.forEach(x => warnings.push((docs.length > 1 ? `#${i + 1}: ` : '') + x));
    if (errors.length) continue;
    for (const d of await recentDuplicates(doc, t)) {
      warnings.push(`${docs.length > 1 ? `#${i + 1}: ` : ''}Possible duplicate: document ${d.number} on ${d.documentDate} for ${d.client?.name}, ${money(d.amount, d.currency)}.`);
    }
    if (!flags['no-preview']) {
      const pdf = await previewPdf(doc, `${label}-${i + 1}`);
      if (pdf) summary.push(`Preview PDF: ${pdf}`);
    }
  }
  if (fatal) { summary.forEach(l => console.log(l)); die('Fix the errors above. No draft was saved.'); }
  if (docs.length > 1) {
    const sum = docs.reduce((s, d) => s + totals(d).gross, 0);
    summary.unshift(`BATCH: ${docs.length} documents, ${money(sum, docs[0].currency)} in total`);
  }
  printDraft(newDraft('create', docs, summary, warnings));
}

async function docSummary(id) {
  const d = await api('GET', `/documents/${id}`);
  return `${TYPES[d.type] || d.type} #${d.number} · ${d.client?.name} · ${money(d.amount, d.currency)} · ${d.documentDate}`;
}

// ---------- execute ----------
async function execute(id, flags) {
  const { draft, file, hash } = loadDraft(id);
  if (Date.now() - draft.created > TTL_MS) die(`Draft ${id} expired (drafts live 30 minutes). Make a new draft.`);
  const okFile = path.join(APPROVAL_DIR, id);
  if (guardActive()) {
    if (!fs.existsSync(okFile)) die(`Draft ${id} has not been approved by the user. Show the draft and wait for an explicit approval.`);
    const ok = JSON.parse(fs.readFileSync(okFile, 'utf8'));
    if (Date.now() - ok.time > TTL_MS) die(`The approval for ${id} expired. Ask again.`);
    if (ok.hash !== hash) die(`Draft ${id} changed after it was approved. Refusing. Make a new draft.`);
  } else if (!flags.yes) {
    die(`Add --yes only after the user explicitly approved draft ${id} in their own message.`);
  }
  CREDS = loadCreds();
  if (CREDS.env !== draft.env) die(`Draft was made for ${draft.env} but credentials now point to ${CREDS.env}.`);
  // consume first: a draft can never run twice, even if a step below fails
  fs.renameSync(file, file.replace(/\.json$/, '.done.json'));
  try { fs.unlinkSync(okFile); } catch {}
  const results = [];
  for (const item of draft.items) {
    let res;
    if (draft.action === 'create') res = await api('POST', '/documents', item);
    else if (draft.action === 'close') res = await api('POST', `/documents/${item.id}/close`);
    else if (draft.action === 'email') res = await api('POST', `/documents/${item.id}/email`, { emails: item.emails });
    else if (draft.action === 'client-add') res = await api('POST', '/clients', item);
    else if (draft.action === 'client-update') res = await api('PUT', `/clients/${item.id}`, item.data);
    else die('Unknown draft action ' + draft.action);
    const row = { time: new Date().toISOString(), draft: id, action: draft.action, env: CREDS.env, id: res?.id || item.id, number: res?.number, url: res?.url?.he || res?.url?.origin };
    fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n');
    results.push(row);
    console.log(`OK  ${draft.action}${row.number ? `  #${row.number}` : ''}  ${row.id || ''}  ${row.url || ''}`);
  }
  console.log(`\nDone: ${results.length} action(s). Logged to ${LEDGER}.`);
  if (draft.action === 'create') console.log('Not emailed. To send it to the client, make an email draft: node morning.mjs draft email <documentId>');
}

// ---------- commands ----------
const HELP = `morning.mjs - Morning (Green Invoice) for Claude Code

Setup and status
  setup [--sandbox]             create ~/.morning-invoice/credentials.txt and open it to paste your key
  check                         test the key (read-only) and show the business and environment

Read (free, no approval)
  clients search <text>         find clients by name
  clients get <id>
  docs search [--type 305,320] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--client text] [--status 0,1] [--page N] [--size N]
  docs get <id>
  docs download <id>            download links
  preview <doc.json>            render a PDF preview without creating anything

Write (always a draft first)
  draft create <doc.json>       one document or a JSON array (batch); validates, checks duplicates, renders previews
  draft close <docId>
  draft email <docId> [--to a@b.com,c@d.com]
  draft client-add <client.json>
  draft client-update <clientId> <fields.json>
  drafts                        list pending drafts
  discard <draftId>
  execute <draftId>             runs an approved draft (needs the user's approval; --yes when no guard hook is installed)

Add --json to read commands for raw output.`;

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, a1, a2] = pos;
  const show = (data, pretty) => console.log(flags.json ? JSON.stringify(data, null, 2) : pretty(data));

  switch (cmd) {
    case 'setup': {
      ensureDirs();
      if (!fs.existsSync(CRED_FILE)) {
        fs.writeFileSync(CRED_FILE, [
          '# Morning API credentials. Paste each value right after the = sign. No quotes, no spaces.',
          '# Get them in Morning: Settings -> Developer tools -> API keys.',
          '# Keep this file private. Never paste these values into a chat.',
          'MORNING_API_KEY_ID=PASTE_KEY_ID_HERE',
          'MORNING_API_SECRET=PASTE_SECRET_HERE',
          '# production = your real account. sandbox = Morning\'s test environment (a separate test account).',
          `MORNING_ENV=${flags.sandbox ? 'sandbox' : 'production'}`,
          '',
        ].join('\n'), { mode: 0o600 });
        console.log('Created ' + CRED_FILE);
      } else console.log('Already exists: ' + CRED_FILE);
      const opener = process.platform === 'win32' ? ['notepad', [CRED_FILE]] : process.platform === 'darwin' ? ['open', ['-t', CRED_FILE]] : ['xdg-open', [CRED_FILE]];
      try { spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref(); console.log('Opened it in a text editor. Paste your key, save, then run: node morning.mjs check'); }
      catch { console.log('Open that file in a text editor, paste your key, save, then run: node morning.mjs check'); }
      return;
    }
    case 'check': {
      CREDS = loadCreds();
      try {
        const b = await api('GET', '/businesses/me', null, { soft: true });
        console.log(`OK  ${CREDS.env.toUpperCase()}  ·  business: ${b.name || b.title || '(unnamed)'}${b.taxId ? `  ·  ${b.taxId}` : ''}`);
      } catch {
        await api('POST', '/clients/search', { page: 1, pageSize: 1 });
        console.log(`OK  ${CREDS.env.toUpperCase()}  ·  key works`);
      }
      console.log(`Key loaded from: ${CREDS.source}`);
      console.log(`Approval guard hook: ${guardActive() ? 'installed (approvals come only from your own messages)' : 'NOT installed (execute needs --yes)'}`);
      return;
    }
    case 'clients': {
      if (sub === 'search') {
        const r = await api('POST', '/clients/search', { page: Number(flags.page || 1), pageSize: Number(flags.size || 25), name: a1 || '' });
        return show(r, x => (x.items || []).map(c => `${c.id}  ${c.name}${c.taxId ? `  ·  ${c.taxId}` : ''}${c.emails?.length ? `  ·  ${c.emails.join(', ')}` : ''}`).join('\n') || 'No clients found.');
      }
      if (sub === 'get') return show(await api('GET', `/clients/${a1}`), x => JSON.stringify(x, null, 2));
      break;
    }
    case 'docs': {
      if (sub === 'search') {
        const body = { page: Number(flags.page || 1), pageSize: Number(flags.size || 25), sort: 'documentDate', sortType: 'desc' };
        if (flags.type) body.type = String(flags.type).split(',').map(Number);
        if (flags.status) body.status = String(flags.status).split(',').map(Number);
        if (flags.from) body.fromDate = flags.from;
        if (flags.to) body.toDate = flags.to;
        const r = await api('POST', '/documents/search', body);
        let items = r.items || [];
        if (flags.client) items = items.filter(i => (i.client?.name || '').includes(flags.client));
        return show({ ...r, items }, () => items.map(i => `${i.documentDate}  #${i.number}  ${(TYPES[i.type] || String(i.type)).split(' · ')[0]}  ·  ${i.client?.name}  ·  ${money(i.amount, i.currency)}  ·  status ${i.status}  ·  ${i.id}`).join('\n') || 'No documents found.');
      }
      if (sub === 'get') return show(await api('GET', `/documents/${a1}`), x => JSON.stringify(x, null, 2));
      if (sub === 'download') return show(await api('GET', `/documents/${a1}/download`), x => JSON.stringify(x, null, 2));
      break;
    }
    case 'preview': {
      CREDS = loadCreds();
      const doc = normalizeDoc(readJson(sub));
      const { errors, warnings, totals: t } = validateDoc(doc);
      docLines(doc, t).forEach(l => console.log(l));
      warnings.forEach(w => console.log('  ! ' + w));
      if (errors.length) { errors.forEach(e => console.log('  ✗ ' + e)); die('Fix the errors above.'); }
      console.log('Preview PDF: ' + await previewPdf(doc, 'preview-' + Date.now()));
      return;
    }
    case 'draft': {
      CREDS = loadCreds();
      if (sub === 'create') return draftCreate(a1, flags);
      if (sub === 'close') return printDraft(newDraft('close', [{ id: a1 }], [`Close document: ${await docSummary(a1)}`], []));
      if (sub === 'email') {
        const doc = await api('GET', `/documents/${a1}`);
        const emails = flags.to ? String(flags.to).split(',').map(s => s.trim()) : (doc.client?.emails || []);
        if (!emails.length) die('No email address. Pass --to address@example.com');
        return printDraft(newDraft('email', [{ id: a1, emails }], [`Email document: ${await docSummary(a1)}`, `To: ${emails.join(', ')}`], []));
      }
      if (sub === 'client-add') {
        const c = readJson(a1);
        if (!c.name) die('Client needs a name.');
        c.active ??= true; c.country ??= 'IL';
        if (typeof c.emails === 'string') c.emails = [c.emails];
        const existing = await api('POST', '/clients/search', { page: 1, pageSize: 10, name: c.name });
        const warn = (existing.items || []).map(x => `A client named "${x.name}" already exists [${x.id}].`);
        return printDraft(newDraft('client-add', [c], [`New client: ${c.name}${c.taxId ? ` · ח.פ ${c.taxId}` : ''}`, `Emails: ${(c.emails || []).join(', ') || '-'}`, `Address: ${[c.address, c.city].filter(Boolean).join(', ') || '-'}`], warn));
      }
      if (sub === 'client-update') {
        const cur = await api('GET', `/clients/${a1}`);
        const data = readJson(a2);
        const diff = Object.entries(data).map(([k, v]) => `  ${k}: ${JSON.stringify(cur[k])} -> ${JSON.stringify(v)}`);
        return printDraft(newDraft('client-update', [{ id: a1, data: { ...cur, ...data } }], [`Update client ${cur.name} [${a1}]`, ...diff], []));
      }
      break;
    }
    case 'drafts': {
      ensureDirs();
      const list = fs.readdirSync(DRAFT_DIR).filter(f => /^[0-9a-f]+\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, f), 'utf8')));
      if (!list.length) return console.log('No pending drafts.');
      for (const d of list) console.log(`${d.id}  ${d.action}  ${d.env}  ${Math.round((Date.now() - d.created) / 60000)} min old${Date.now() - d.created > TTL_MS ? ' (expired)' : ''}  ·  ${d.summary.find(Boolean)}`);
      return;
    }
    case 'discard': {
      const { file } = loadDraft(sub);
      fs.unlinkSync(file);
      return console.log(`Discarded draft ${sub}.`);
    }
    case 'execute': return execute(sub, flags);
  }
  console.log(HELP);
}

main().catch(e => die(redact(e.stack || e.message)));
