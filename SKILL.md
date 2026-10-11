---
name: morning-invoice
description: Create invoices, receipts, quotes and credit notes, and manage clients in Morning (Green Invoice / חשבונית ירוקה) through its API. Use when the user wants to issue a חשבונית מס, חשבונית מס קבלה, חשבון עסקה, קבלה, הצעת מחיר or חשבונית זיכוי, add or find a client, look up, close or email documents, or bulk-create documents from a list. Every write is a draft that runs only after the user approves it.
argument-hint: [action] [client-name] [amount] [description]
allowed-tools: Bash(node:*), Read, Write, Glob, AskUserQuestion
---

# Morning (Green Invoice)

Everything goes through one script. Never call the Green Invoice API any other way (no curl, no inline fetch,
no ad-hoc scripts); the guard hook blocks it.

```
M="node $HOME/.claude/skills/morning-invoice/scripts/morning.mjs"
$M check            # key, environment, business name, guard status
$M help
```

These are real tax documents in a live account. **Cardinal rule: nothing is created, closed, emailed or
changed unless the user approved that exact draft in their own message.**

## Reads (free, no approval)

```
$M clients search "<name>"            $M clients get <id>
$M docs search [--type 300,320] [--from 2026-10-01] [--to ...] [--client "<text>"] [--status 0,1] [--size 50]
$M docs get <id>                      $M docs download <id>
$M preview doc.json                   # PDF preview, creates nothing
```
Add `--json` for raw output. Status 0 = open, 1 = closed.

## Writes: draft -> approval -> execute

1. **Gather** what's missing (client, type, amount, VAT, payment method). Ask one AskUserQuestion when something
   changes the money (e.g. "850 ₪ an hour" before or including VAT).
2. **Search the client first** (`clients search`). Reuse `{"id": ...}` when found; otherwise pass the full client
   object and it is saved (`add: true`).
3. **Write the document JSON** (Write tool, a temp file) and run `$M draft create doc.json`. The script fills
   defaults, validates, checks for a duplicate in the last 45 days and renders a preview PDF.
   Other drafts: `draft close <docId>`, `draft email <docId> [--to a@b.com]`, `draft client-add c.json`,
   `draft client-update <id> fields.json`.
4. **Show the user** the draft summary and the preview PDF (Read it), then **end your turn and wait**.
5. The user approves by replying with a short message ("אשר", "כן", "הפק", "yes", "approve", or the draft id).
   Any hesitation ("רגע", "תשנה", "no", "wait") approves nothing; make a new draft with the change.
6. Only then run `$M execute <draftId>` once. Report the document number and link.
7. Never email a document unless the user asks; emailing is its own draft.

A JSON array in `draft create` is a batch: one summary, one approval, executed in order at Morning's rate limit.

## How the gate works (don't try to bypass it; if it blocks you, tell the user)

- **Hook** (`~/.claude/hooks/morning-guard.mjs`, installed by `scripts/install-guard.mjs`):
  - UserPromptSubmit: a short approval right after a draft writes a one-time approval bound to the draft's
    content hash. Nothing else creates approvals.
  - PreToolUse: `execute` without a valid approval -> deny. Direct Green Invoice API calls -> deny. Tools
    writing into `~/.morning-invoice` or reading the credentials -> deny. Edits to the guard -> deny.
- **morning.mjs** refuses too: drafts expire after 30 minutes, run once, and refuse if changed after approval
  or if the environment changed. Every executed action is logged to `~/.morning-invoice/ledger.jsonl`.
- Without the hook installed, `execute` needs `--yes`; add it only after the user's explicit approval.

## Credentials

Read in this order: environment variables `MORNING_API_KEY_ID` / `MORNING_API_SECRET` (+ optional
`MORNING_ENV=sandbox`), then `~/.morning-invoice/credentials.txt` (created by `$M setup`), then on Windows the
user-level environment in the registry (so a key set with setx works before a restart).
Never print, read or paste the secret. Test with `$M check`.

## Document JSON

Minimal (defaults: type 320, lang he, ILS, vatType 0, date today, row vatType 1 = price includes VAT):
```json
{
  "type": 300,
  "client": { "id": "existing-client-id" },
  "income": [ { "description": "בנק שעות - פרויקטי AI", "quantity": 5, "price": 850, "vatType": 0 } ]
}
```
New client inline: `"client": {"name": "...", "taxId": "...", "emails": ["..."], "address": "...", "city": "...", "phone": "..."}`.
Optional: `dueDate`, `remarks`, `description`, `footer`, `discount` `{"amount":10,"type":"percentage"|"sum"}`,
`linkedDocumentIds` (closes the linked doc), `payment` rows.

### Document types
| Code | Hebrew | Payment rows |
|---|---|---|
| 10 | הצעת מחיר | none |
| 100 | הזמנה | none |
| 200 / 210 | תעודת משלוח / החזרה | none |
| **300** | **חשבון עסקה** (invoiced, not paid yet) | none |
| **305** | **חשבונית מס** | none |
| **320** | **חשבונית מס / קבלה** (invoiced + paid) | required |
| 330 | חשבונית זיכוי | none |
| **400** | **קבלה** | required |
| 405 | קבלה על תרומה | required |
| 500 | הזמנת רכש | none |

Common flow: 300 when the work is done; when paid, a 320 with `linkedDocumentIds: ["<the 300 id>"]`, which closes the 300.
Morning does not allow backdating a 300 by more than about a day (the script stops it).

### VAT
- Document `vatType`: 0 = default (18%), 1 = exempt, 2 = mixed.
- Row `vatType`: 0 = VAT added on top of the price, 1 = price already includes VAT, 2 = exempt.
- B2B hourly / project prices are usually quoted before VAT (row vatType 0). Consumer prices usually include VAT
  (1). When unclear, ask; the draft summary always states which one applies and shows the total.

### Payment rows
`{"type": 4, "price": 5015, "date": "2026-10-11"}` plus optional `bankName`, `bankBranch`, `bankAccount`,
`chequeNum`, `cardType`, `cardNum` (last 4). Types: 0 tax deduction, 1 cash, 2 cheque, 3 credit card, 4 wire
transfer, 5 PayPal, 10 payment app (Bit/Pay), 11 other. Payments must equal the document total (incl. VAT).

Currencies: ILS (default), USD, EUR, GBP and ~25 more ISO codes.

## Notes
- Rate limit ~3 requests/second; the script paces itself and retries on 429.
- `check` shows the business the key belongs to. Use the sandbox (`MORNING_ENV=sandbox`, separate test account
  and key) to practise.
