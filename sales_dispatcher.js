#!/usr/bin/env node
/**
 * Alpha Pulse — Sales Dispatcher
 * Queries D1, extracts Israeli contact info, sends to Telegram.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=<token> node sales_dispatcher.js
 *   or paste your token into the TOKEN variable below.
 */

const { execSync } = require("child_process");

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN       = process.env.TELEGRAM_BOT_TOKEN || "PASTE_YOUR_TOKEN_HERE";
const CHAT_ID     = "7726489288";
const LIMIT       = 5;          // change to process more records
const DELAY_MS    = 2000;
const BUSINESS_ID = "bakrayot_historical_2007";
// ─────────────────────────────────────────────────────────────────────────────

const PHONE_RE = /\b(0(?:5[0-9]|[234678])\d{7,8})\b/g;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractPhones(text) {
  if (!text) return [];
  const matches = [...text.matchAll(PHONE_RE)];
  return [...new Set(matches.map((m) => m[1]))];
}

function buildMessage(title, phones, link) {
  const phoneLines = phones.length
    ? phones.map((p) => `📞 *Phone:* ${p}`).join("\n")
    : "📞 *Phone:* Not found";
  const linkLine = link ? `\n🔗 ${link}` : "";
  return (
    `🎯 *Historical Lead Recovered*\n\n` +
    `📌 *Title:* ${title || "N/A"}\n` +
    `${phoneLines}` +
    `${linkLine}\n\n` +
    `✅ *Action:* Needs qualification call.`
  );
}

async function sendTelegram(message) {
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text: message,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });

  const res = await fetch(
    `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }
  );

  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram error: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  if (TOKEN === "PASTE_YOUR_TOKEN_HERE") {
    console.error("[ERROR] Set TELEGRAM_BOT_TOKEN env var or paste your token into the script.");
    process.exit(1);
  }

  console.log(`[Alpha Pulse] Querying D1 — business_id: ${BUSINESS_ID}, limit: ${LIMIT}\n`);

  // Query D1 remotely via wrangler
  const cmd = `npx wrangler d1 execute bakrayot-alpha --remote --json ` +
    `--command="SELECT * FROM leads WHERE business_id='${BUSINESS_ID}' LIMIT ${LIMIT};"`;

  let stdout = "";
  let stderr = "";
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    stdout = out;
  } catch (e) {
    stdout = e.stdout || "";
    stderr = e.stderr || e.message || "";
  }

  if (stderr.trim()) console.error("[WRANGLER STDERR]\n", stderr.trim());
  if (!stdout.trim()) {
    console.error("[ERROR] wrangler produced no stdout. Check auth / DB name.");
    process.exit(1);
  }

  // Strip any non-JSON prefix (wrangler warnings, ANSI lines) before the first '['
  const jsonStart = stdout.indexOf("[");
  if (jsonStart === -1) {
    console.error("[ERROR] No JSON array found in wrangler output.\n[RAW STDOUT]\n", stdout);
    process.exit(1);
  }
  const jsonStr = stdout.slice(jsonStart);

  let results;
  try {
    const parsed = JSON.parse(jsonStr);
    results = parsed[0]?.results ?? [];
  } catch (e) {
    console.error("[ERROR] JSON parse failed:", e.message);
    console.error("[RAW JSON STRING]\n", jsonStr.slice(0, 500));
    process.exit(1);
  }

  console.log(`[Alpha Pulse] ${results.length} record(s) retrieved.\n`);

  let sent = 0;
  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    let leadObj = {};

    try {
      leadObj = JSON.parse(row.lead_data);
    } catch {
      leadObj = { title: row.lead_data };
    }

    // Flatten all text for phone search
    const fullText = JSON.stringify(leadObj);
    const phones   = extractPhones(fullText);

    const title = leadObj.title || leadObj.name || `Record ${i + 1}`;
    const link  = leadObj.link || "";

    const message = buildMessage(title, phones, link);

    try {
      await sendTelegram(message);
      console.log(`[${i + 1}/${results.length}] Sent — "${title}" | Phones: ${phones.length ? phones.join(", ") : "none"}`);
      sent++;
    } catch (err) {
      console.error(`[${i + 1}/${results.length}] FAILED — ${err.message}`);
    }

    if (i < results.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n[Alpha Pulse] Done. Dispatched ${sent}/${results.length} messages to Telegram.`);
}

main();
