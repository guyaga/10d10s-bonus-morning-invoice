#!/usr/bin/env node
// morning-guard.mjs - approval gate for the morning-invoice skill (Morning / Green Invoice).
// Nothing is created, closed, emailed or changed in Morning unless the user approved that exact
// draft in their own typed message.
//
// UserPromptSubmit: a short approval right after a draft was shown writes a one-time approval
//   bound to the draft's content hash. This is the only thing that creates approvals.
// PreToolUse:
//   `morning.mjs execute <id>` without a valid approval            -> deny
//   raw Green Invoice API calls outside morning.mjs                  -> deny
//   tools writing into ~/.morning-invoice (drafts, approvals, keys)  -> deny
//   reading the credentials file                                     -> deny
// Anything else passes through. Errors fail open, except for an execute command (fails closed).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = process.env.MORNING_HOME || path.join(os.homedir(), '.morning-invoice');
const DRAFT_DIR = path.join(HOME, 'drafts');
const OK_DIR = path.join(HOME, 'approvals');
const LAST_PROMPT = path.join(OK_DIR, '_last_prompt');
const TTL_MS = 30 * 60 * 1000;
const APPROVE = /\b(yes|approve[d]?|go|ok|okay|confirm(ed)?|do it|send( it)?|create( it)?)\b|אשר|מאשר|מאושר|אישור|כן|הפק|תפיק|תוציא|שלח|תשלח|יאללה|סבבה|קדימה/i;
const NEGATE = /\b(no|not|don'?t|dont|wait|stop|cancel|change|edit|fix|instead)\b|לא|אל |רגע|עצור|תשנה|תתקן|במקום|בטל|חכה/i;
const EXEC = /morning\.mjs["']?\s+execute\s+([0-9a-f]{6})\b/g;
const HOME_REF = /[\\/]\.morning-invoice\b/i;
const NET_CALL = /\b(curl|wget|fetch|https?\.request|Invoke-RestMethod|Invoke-WebRequest|irm|iwr|requests\.|axios|urllib|http\.client)\b/i;

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function out(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
}

function pendingDrafts() {
  if (!fs.existsSync(DRAFT_DIR)) return [];
  return fs.readdirSync(DRAFT_DIR).filter(f => /^[0-9a-f]{6}\.json$/.test(f)).map(f => {
    const file = path.join(DRAFT_DIR, f);
    return { ...JSON.parse(fs.readFileSync(file, 'utf8')), file };
  }).filter(d => Date.now() - d.created < TTL_MS);
}

function draftText(id) {
  const f = path.join(DRAFT_DIR, id + '.json');
  if (!fs.existsSync(f)) return `Draft ${id} not found.`;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  return `MORNING ${d.action.toUpperCase()} (${d.env}) - draft ${d.id}\n` + d.summary.join('\n');
}

function onPrompt(prompt) {
  fs.mkdirSync(OK_DIR, { recursive: true });
  const last = fs.existsSync(LAST_PROMPT) ? Number(fs.readFileSync(LAST_PROMPT, 'utf8')) : 0;
  fs.writeFileSync(LAST_PROMPT, String(Date.now()));
  const p = prompt.trim();
  const drafts = pendingDrafts();
  if (!drafts.length || p.length > 80 || NEGATE.test(p)) return;
  let chosen = drafts.filter(d => new RegExp(`\\b${d.id}\\b`).test(p));
  if (!chosen.length) {
    if (!APPROVE.test(p)) return;
    const fresh = drafts.filter(d => d.created > last); // shown in the reply right before this message
    if (fresh.length > 1 || (!fresh.length && drafts.length > 1)) {
      console.log('Morning guard: several drafts are pending. Nothing approved. Ask the user which draft id to run.');
      return;
    }
    chosen = fresh.length ? fresh : drafts;
  }
  if (chosen.length !== 1) return;
  const d = chosen[0];
  fs.writeFileSync(path.join(OK_DIR, d.id), JSON.stringify({ time: Date.now(), hash: sha(d.file) }));
  console.log(`Morning guard: the user approved draft ${d.id} (${d.action}, ${d.env}). You may run \`morning.mjs execute ${d.id}\` once.`);
}

function scriptsIn(cmd) {
  const texts = [];
  for (const tok of cmd.match(/[\w:\\/.~-]+\.(?:py|js|mjs|cjs|ts|ps1|sh)\b/g) || []) {
    let p = tok.replace(/^['"]|['"]$/g, '');
    const m = p.match(/^\/([a-zA-Z])\/(.*)/);
    if (m) p = `${m[1]}:/${m[2]}`;
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    if (/(^|[\\/])(morning\.mjs|morning-guard\.mjs)$/.test(p)) continue;
    try { if (fs.statSync(p).size < 2e6) texts.push(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return texts;
}

const rawApi = t => /greeninvoice\.co\.il/i.test(t) && (NET_CALL.test(t) || /\b(POST|PUT|DELETE)\b/.test(t));

function onTool(tool, inp) {
  const blob = JSON.stringify(inp);
  if (tool === 'Read' && HOME_REF.test(String(inp.file_path || '')) && /credentials/i.test(String(inp.file_path))) {
    out('deny', 'The Morning credentials file stays private. Use `morning.mjs check` to test the key.');
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const fp = String(inp.file_path || inp.notebook_path || '').replace(/\\/g, '/');
    if (HOME_REF.test(fp)) out('deny', 'Files in ~/.morning-invoice (drafts, approvals, credentials) are written only by morning.mjs and the guard.');
    if (fp.endsWith('hooks/morning-guard.mjs') || (fp.endsWith('settings.json') && /morning-guard/.test(blob))) {
      out('deny', 'This edits the Morning approval guard. The user changes it by hand.');
    }
    return;
  }
  if (tool !== 'Bash' && tool !== 'PowerShell') return;
  const cmd = String(inp.command || '');

  if (HOME_REF.test(cmd) && /(approvals|drafts|credentials)/i.test(cmd)) {
    out('deny', 'Commands may not touch Morning drafts, approvals or credentials directly. Use morning.mjs.');
  }
  if (/morning-guard/.test(cmd) && /settings\.json/.test(cmd)) out('deny', 'This edits the Morning approval guard registration. The user changes it by hand.');

  const inline = cmd.replace(/morning\.mjs[^\n;&|]*/g, '');
  if (rawApi(inline) || scriptsIn(cmd).some(rawApi)) {
    out('deny', 'Blocked: a direct Green Invoice API call. All Morning calls go through morning.mjs (reads directly, writes as draft -> user approval -> execute).');
  }

  const ids = [...cmd.matchAll(EXEC)].map(m => m[1]);
  if (/morning\.mjs["']?\s+execute\b/.test(cmd)) {
    if (ids.length !== 1) out('deny', 'One Morning execute per command, with an explicit draft id.');
    const id = ids[0];
    const okFile = path.join(OK_DIR, id), draftFile = path.join(DRAFT_DIR, id + '.json');
    let ok = null;
    try { ok = JSON.parse(fs.readFileSync(okFile, 'utf8')); } catch {}
    if (!ok || Date.now() - ok.time > TTL_MS || !fs.existsSync(draftFile) || ok.hash !== sha(draftFile)) {
      out('deny', `The user has not approved draft ${id} (or it changed or expired). Show the draft and wait for their explicit approval.\n\n${draftText(id)}`);
    }
  }
}

let data = {};
try {
  data = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (data.hook_event_name === 'UserPromptSubmit') onPrompt(String(data.prompt || ''));
  else onTool(data.tool_name || '', data.tool_input || {});
} catch (e) {
  if (/execute/.test(JSON.stringify(data.tool_input || {}))) out('deny', `morning-guard error (${e.message}); execute blocked.`);
}
