# Alpha Pulse — Master State Document
**Project:** bakrayot-alpha-pulse
**Account:** Asher@hub.co.il (Cloudflare Account ID: `f7e821c3d4440f0364c8f614e229f747`)
**GitHub:** https://github.com/ashernov/bakrayot-alpha-pulse
**Session Date:** 2026-04-02

---

## 1. Live Infrastructure

| Resource | Details |
|----------|---------|
| **Worker URL** | `https://bakrayot-alpha-pulse.asher-f7e.workers.dev` |
| **D1 Database** | `bakrayot-alpha` — ID: `36fbeba0-2c5b-4b46-99cc-4509a7afccb3` — Region: EEUR (Frankfurt) |
| **Cron Trigger** | `0 16 * * *` (16:00 UTC daily) |
| **Telegram Chat ID** | `7726489288` |
| **Cloudflare Secret** | `TELEGRAM_BOT_TOKEN` (set via `wrangler secret put`) |

---

## 2. Cloudflare Worker — Routing Logic (`src/index.ts`)

### Endpoints

#### `POST /leads`
Accepts a JSON body and inserts a new lead into the D1 `leads` table.

- `business_id` — extracted from body (defaults to `"unknown"` if absent)
- `id` — auto-generated `crypto.randomUUID()` (prevents collisions from multiple frontends)
- `lead_data` — full request body stringified as JSON
- Returns `{ "success": true, "id": "<uuid>" }` with HTTP 201

**Example request:**
```bash
curl -X POST https://bakrayot-alpha-pulse.asher-f7e.workers.dev/leads \
  -H "Content-Type: application/json" \
  -d '{"business_id": "my_biz", "lead_data": "{\"name\": \"John\"}"}'
```

#### `GET /` (catch-all)
Returns plain text: `bakrayot-alpha-pulse is live`

### Scheduled Handler (`0 16 * * *`)
Runs `sendDailySummary()` which:
1. Queries leads from the past 24 hours grouped by `business_id`
2. Formats a Markdown summary message
3. POSTs to Telegram Bot API → Chat ID `7726489288`

---

## 3. D1 Database Schema

**Database:** `bakrayot-alpha`
**Table:** `leads`

```sql
CREATE TABLE IF NOT EXISTS leads (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  lead_data   TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### business_id Conventions

| business_id | Purpose |
|-------------|---------|
| `bakrayot_historical_2007` | 7,634 records imported from WordPress export (`WordPress.2026-04-02.xml`) |
| `demo_business` | Test record inserted during initial verification |
| `unknown` | Fallback when no `business_id` provided in POST body |

---

## 4. Telegram Bot Integration

### Daily Cron Report (16:00 UTC)
Triggered automatically by Cloudflare's scheduler. Query:
```sql
SELECT business_id, COUNT(*) as total_leads
FROM leads
WHERE created_at >= datetime('now', '-24 hours')
GROUP BY business_id
ORDER BY total_leads DESC
```

**Message format:**
```
📊 Alpha Pulse Daily Report

• `demo_business`: *3* leads
• `bakrayot_historical_2007`: *7634* leads

*Total: 7637 leads in last 24h*
```

### Manual Cron Test
To trigger the summary without waiting for the cron schedule:
```bash
# Temporary endpoint method (deploy, call, redeploy clean)
# Or trigger via wrangler:
npx wrangler dispatch-namespace ...
```

---

## 5. Historical Data Injection

**Source file:** `WordPress.2026-04-02.xml` (WordPress WXR export)
**Script used:** `seed_xml.js` (deleted post-execution — see logic below)
**Records injected:** 7,634
**Failures:** 0
**business_id:** `bakrayot_historical_2007`

### seed_xml.js Logic (archived for reference)
1. Parsed XML with `xml2js`
2. Extracted `<item>` elements: title, link, pubDate, `content:encoded`
3. Mapped each to `{ business_id, lead_data: JSON.stringify({title, link, pubDate, content}) }`
4. POSTed each to `/leads` with 200ms delay between requests
5. Worker auto-assigned UUID primary keys

---

## 6. Sales Dispatcher (`sales_dispatcher.js`)

Queries D1 remotely and dispatches recovered lead summaries to Telegram for sales team action.

### Configuration (top of file)
```js
const TOKEN       = process.env.TELEGRAM_BOT_TOKEN || "PASTE_YOUR_TOKEN_HERE";
const CHAT_ID     = "7726489288";
const LIMIT       = 5;          // increase to process more records
const DELAY_MS    = 2000;       // 2s between Telegram messages
const BUSINESS_ID = "bakrayot_historical_2007";
```

### Israeli Phone Number Regex
```js
const PHONE_RE = /\b(0(?:5[0-9]|[234678])\d{7,8})\b/g;
```
Matches: `05x-xxxxxxx`, `04xxxxxxxx`, `02xxxxxxxx`, `03xxxxxxxx`, `08xxxxxxxx`, `09xxxxxxxx`

### JSON Parsing (robust)
Wrangler prepends warning/info lines to stdout. The parser slices from the first `[` character to isolate the JSON array:
```js
const jsonStart = stdout.indexOf("[");
const jsonStr   = stdout.slice(jsonStart);
const parsed    = JSON.parse(jsonStr);
const results   = parsed[0]?.results ?? [];
```

### Telegram Message Format
```
🎯 Historical Lead Recovered

📌 Title: <title>
📞 Phone: <phone or "Not found">
🔗 <link>

✅ Action: Needs qualification call.
```

### Run Command
```bash
TELEGRAM_BOT_TOKEN=<token> node sales_dispatcher.js
```

To paginate through all 7,634 records, increase `LIMIT` and add SQL `OFFSET` in batches.

---

## 7. Secrets & Environment

| Secret | Storage | How to update |
|--------|---------|---------------|
| `TELEGRAM_BOT_TOKEN` | Cloudflare Worker Secret | `npx wrangler secret put TELEGRAM_BOT_TOKEN` |

**Never commit the bot token to git.** `.gitignore` excludes `.dev.vars` and `*.env`.

---

## 8. Key Commands Reference

```bash
# Deploy worker
npx wrangler deploy

# Query production DB
npx wrangler d1 execute bakrayot-alpha --remote --command="SELECT COUNT(*) FROM leads;"

# Apply schema changes
npx wrangler d1 execute bakrayot-alpha --remote --file=schema.sql

# Update Telegram secret
npx wrangler secret put TELEGRAM_BOT_TOKEN

# Run sales dispatcher (batch of 5)
TELEGRAM_BOT_TOKEN=<token> node sales_dispatcher.js

# Check deployment status
npx wrangler deployments list
```

---

## 9. Scaling Plan (Next Session)

- Increase `LIMIT` in `sales_dispatcher.js` and add `OFFSET` pagination to process all 7,634 historical records
- Add a `status` column to `leads` table to track `dispatched` / `qualified` / `closed`
- Consider a `/leads/query` endpoint on the Worker for filtered reads
- Evaluate adding a second `business_id` namespace for live incoming leads vs historical data
