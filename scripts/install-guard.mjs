#!/usr/bin/env node
// install-guard.mjs - installs the Morning approval guard as a Claude Code hook (idempotent).
// Copies morning-guard.mjs to ~/.claude/hooks and registers it for UserPromptSubmit and PreToolUse
// in ~/.claude/settings.json. Existing settings and hooks are kept as they are.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const claude = path.join(os.homedir(), '.claude');
const target = path.join(claude, 'hooks', 'morning-guard.mjs');
const settingsFile = path.join(claude, 'settings.json');

fs.mkdirSync(path.dirname(target), { recursive: true });
const src = path.join(here, 'morning-guard.mjs');
if (path.resolve(src) !== path.resolve(target)) fs.copyFileSync(src, target);

const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, '')) : {};
if (fs.existsSync(settingsFile)) fs.copyFileSync(settingsFile, settingsFile + '.bak-morning');
const command = `node "${target.replace(/\\/g, '/')}"`;
settings.hooks ??= {};
const add = (event, matcher) => {
  settings.hooks[event] ??= [];
  const has = settings.hooks[event].some(m => (m.hooks || []).some(h => String(h.command).includes('morning-guard')));
  if (!has) settings.hooks[event].push({ matcher, hooks: [{ type: 'command', command, timeout: 10 }] });
};
add('UserPromptSubmit', '');
add('PreToolUse', 'Bash|PowerShell|Read|Edit|Write|MultiEdit|NotebookEdit');
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
console.log(`Morning guard installed: ${target}\nRegistered in ${settingsFile} (backup: settings.json.bak-morning).\nIt takes effect in the next prompt of any Claude Code session.`);
