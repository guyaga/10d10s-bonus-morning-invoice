# מורנינג · חשבוניות מתוך Claude Code

מוציאים חשבוניות, קבלות, חשבונות עסקה והצעות מחיר בחשבון ה-Morning (חשבונית ירוקה) שלכם, בעברית רגילה:

> "תוציא חשבון עסקה לחברת אקמה על 5 שעות ב-850 ₪ לשעה פלוס מע"מ"

Claude מוצא את הלקוח (או פותח חדש), בונה את המסמך, מראה לכם PDF תצוגה מקדימה, ומפיק אותו רק אחרי שאתם כותבים "אשר".

## מה זה עושה

- כל סוגי המסמכים: חשבונית מס קבלה, חשבונית מס, חשבון עסקה, קבלה, הצעת מחיר, חשבונית זיכוי, הזמנה ועוד
- לקוחות: חיפוש, פתיחת לקוח חדש, עדכון פרטים
- מסמכים: חיפוש, הורדה, סגירה, שליחה במייל ללקוח
- חשבון עסקה ← חשבונית מס קבלה כשהלקוח משלם (המקורי נסגר אוטומטית)
- הפקה מרוכזת מרשימה: טבלה אחת, אישור אחד

## בטיחות: אלה מסמכים אמיתיים

- **כל פעולת כתיבה היא טיוטה.** Claude מראה סיכום ו-PDF, ושום דבר לא נשלח ל-Morning עד שאתם מאשרים.
- **האישור מגיע רק מכם.** הוק קטן בודק שההודעה "אשר" נכתבה על ידכם, מיד אחרי הטיוטה, ושהטיוטה לא השתנתה מאז. בלי האישור הזה ההפקה נחסמת, גם במצב bypass.
- **בדיקות לפני הפקה:** סכום התשלום מול סכום המסמך, תאריך עבר בחשבון עסקה, כפילות מול מסמכים מ-45 הימים האחרונים, סכום חריג.
- **המפתח שלכם נשאר אצלכם.** מדביקים אותו בעצמכם לקובץ מקומי (`~/.morning-invoice/credentials.txt`), לא בצ'אט. Claude חסום מלקרוא אותו.
- **יומן:** כל פעולה שבוצעה נרשמת ב-`~/.morning-invoice/ledger.jsonl`.
- **מצב ניסיון:** `MORNING_ENV=sandbox` עובד מול סביבת הבדיקות של Morning (חשבון ומפתח נפרדים).

הסקיל לא מחליף רואה חשבון. בודקים את הטיוטה לפני שמאשרים.

## מה צריך

1. חשבון Morning שכולל גישה ל-API. המפתח נמצא ב: **הגדרות ← כלים למפתחים ← מפתחות API**. לא רואים את המסך? כנראה שהמסלול שלכם לא כולל API.
2. Claude Code ו-Node.js 18 ומעלה. אין חבילות להתקין.

## התקנה

מדביקים ל-Claude Code:

```
Install the Morning invoice skill from https://github.com/guyaga/10d10s-bonus-morning-invoice: clone it to ~/.claude/skills/morning-invoice, then in that folder run `node scripts/install-guard.mjs` and `node scripts/morning.mjs setup`. Setup opens a file where I paste my Morning API key myself - never ask me for the key in the chat. When I say I saved it, run `node scripts/morning.mjs check` and show me the result.
```

`check` מציג את שם העסק שהמפתח שייך לו, ואם ההוק מותקן.

## בקשות לדוגמה

- "תמצא לי את כל החשבונות עסקה הפתוחים מהחודש האחרון"
- "תוציא חשבונית מס קבלה לדנה כהן על 1,500 ₪ כולל מע"מ, שולם בביט"
- "דנה שילמה את חשבון העסקה 1020 בהעברה בנקאית. תוציא חשבונית מס קבלה ותסגור אותו"
- "תשלח במייל את חשבונית 1050 ללקוח"

## איך זה בנוי

```
SKILL.md                    ההוראות ל-Claude
scripts/morning.mjs         כל הקריאות ל-Morning API (קריאה חופשית, כתיבה דרך טיוטה)
scripts/morning-guard.mjs   ההוק שמוודא שהאישור הגיע מכם
scripts/install-guard.mjs   רושם את ההוק ב-~/.claude/settings.json (גיבוי נשמר)
examples/                   קבצי JSON לדוגמה
```

פקודות ידניות: `node scripts/morning.mjs help`

---

## Instructions for Claude

1. `git clone https://github.com/guyaga/10d10s-bonus-morning-invoice ~/.claude/skills/morning-invoice` (if the folder exists, `git pull` instead).
2. In that folder: `node scripts/install-guard.mjs` (registers the approval hook; keeps a backup of settings.json).
3. `node scripts/morning.mjs setup` creates `~/.morning-invoice/credentials.txt` and opens it. Tell the user to paste their key ID and secret after the `=` signs (no quotes), save, and tell you. **Never ask for the key in chat and never read that file.** Users who prefer environment variables can set `MORNING_API_KEY_ID` and `MORNING_API_SECRET` instead.
4. `node scripts/morning.mjs check` and show the result (business name, environment, guard status).
5. From then on follow `SKILL.md`: reads are free; every write is `draft` → show the user → wait for their own approval → `execute <id>`.

MIT License.
