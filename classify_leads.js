#!/usr/bin/env node
/**
 * Alpha Pulse — Lead Classifier & Clean Table Builder
 * Scans bakrayot_historical_2007, classifies into BUSINESS/MEDIA/JUNK,
 * creates leads_clean table, inserts BUSINESS records only.
 */

const { execSync } = require("child_process");

const DB      = "bakrayot-alpha";
const BIZ_ID  = "bakrayot_historical_2007";
const BATCH   = 200;

const PHONE_RE = /\b(0(?:5[0-9]|[234678])\d{7,8})\b/g;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// ── Classification logic ───────────────────────────────────────────────────
function classify(title, link, content) {
  const t = (title  || "").trim();
  const l = (link   || "").trim();
  const c = (content|| "").trim();

  // JUNK: PHP serialized ACF data or post_type metadata URL
  if (/a:\d+:\{s:\d+:/.test(c)) return "JUNK";
  if (l.includes("post_type=acf-field")) return "JUNK";
  if (l.includes("post_type=")) return "JUNK";
  if (/^a:\d+:\{/.test(c)) return "JUNK";

  // MEDIA: empty content + filename title or attachment URL
  if (c === "") {
    if (/\.(jpe?g|png|gif|pdf|mp4|webp|svg|ico|bmp|tiff|zip|docx?|xlsx?|pptx?)\b/i.test(t)) return "MEDIA";
    if (l.includes("/attachment/")) return "MEDIA";
    if (/^[a-z0-9_\-]{3,40}$/i.test(t) && !/[\u0590-\u05FF]/.test(t)) return "MEDIA";
  }

  // BUSINESS: Hebrew title or non-empty meaningful content
  if (/[\u0590-\u05FF]/.test(t)) return "BUSINESS";
  if (c.length > 100) return "BUSINESS";
  if (t.length > 3 && c === "") return "MEDIA"; // short latin title, no content

  return "JUNK";
}

// ── SQL helpers ────────────────────────────────────────────────────────────
function esc(str) {
  return (str || "").replace(/'/g, "''").replace(/\0/g, "");
}

function runSQL(sql) {
  const cmd = `npx wrangler d1 execute ${DB} --remote --json --command="${sql.replace(/"/g, '\\"')}"`;
  try {
    const out = execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe","pipe","pipe"] });
    const start = out.indexOf("[");
    if (start === -1) return [];
    const parsed = JSON.parse(out.slice(start));
    return parsed[0]?.results ?? [];
  } catch (e) {
    const raw = e.stdout || "";
    const start = raw.indexOf("[");
    if (start !== -1) {
      try {
        const parsed = JSON.parse(raw.slice(start));
        return parsed[0]?.results ?? [];
      } catch {}
    }
    console.error("[SQL ERROR]", (e.stderr || e.message || "").slice(0, 300));
    return [];
  }
}

function runSQLVoid(sql) {
  const fs = require("fs");
  const tmpFile = `_tmp_sql_${Date.now()}.sql`;
  fs.writeFileSync(tmpFile, sql, "utf8");
  try {
    const cmd = `npx wrangler d1 execute ${DB} --remote --file="${tmpFile}"`;
    execSync(cmd, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  // 1. Count total
  const countRes = runSQL(`SELECT COUNT(*) as n FROM leads WHERE business_id='${BIZ_ID}'`);
  const total = countRes[0]?.n ?? 0;
  console.log(`[Classifier] Total records to scan: ${total}\n`);

  const counts = { BUSINESS: 0, MEDIA: 0, JUNK: 0 };
  const businessRows = []; // { name, link, phone, email }

  // 2. Fetch in batches and classify
  for (let offset = 0; offset < total; offset += BATCH) {
    const rows = runSQL(
      `SELECT id, lead_data FROM leads WHERE business_id='${BIZ_ID}' LIMIT ${BATCH} OFFSET ${offset}`
    );

    for (const row of rows) {
      let outer = {};
      try { outer = JSON.parse(row.lead_data); } catch { outer = {}; }

      let inner = {};
      try { inner = JSON.parse(outer.lead_data || "{}"); } catch { inner = {}; }

      const title   = inner.title   || "";
      const link    = inner.link    || "";
      const content = inner.content || "";

      const phones = [...(JSON.stringify(inner).matchAll(PHONE_RE))].map(m => m[1]);
      const emails = [...(JSON.stringify(inner).matchAll(EMAIL_RE))].map(m => m[0]);
      const phone  = [...new Set(phones)].join(", ");
      const email  = [...new Set(emails)].join(", ");

      const cat = classify(title, link, content);
      counts[cat]++;

      if (cat === "BUSINESS") {
        businessRows.push({ id: row.id, name: title, link, phone, email });
      }
    }

    const done = Math.min(offset + BATCH, total);
    process.stdout.write(`\r  Scanned ${done}/${total}...`);
  }

  console.log(`\n\n[Classifier] Classification complete:`);
  console.log(`  BUSINESS : ${counts.BUSINESS}`);
  console.log(`  MEDIA    : ${counts.MEDIA}`);
  console.log(`  JUNK     : ${counts.JUNK}`);
  console.log(`  TOTAL    : ${counts.BUSINESS + counts.MEDIA + counts.JUNK}\n`);

  // 3. Create leads_clean table (drop first for clean run)
  console.log("[Classifier] Creating leads_clean table...");
  runSQLVoid("DROP TABLE IF EXISTS leads_clean");
  runSQLVoid("CREATE TABLE leads_clean (id TEXT PRIMARY KEY, name TEXT, link TEXT, category TEXT, phone TEXT, email TEXT)");

  // 4. Insert BUSINESS records in batches of 10
  console.log(`[Classifier] Inserting ${businessRows.length} BUSINESS records into leads_clean...`);
  const INSERT_BATCH = 10;
  let inserted = 0;

  for (let i = 0; i < businessRows.length; i += INSERT_BATCH) {
    const chunk = businessRows.slice(i, i + INSERT_BATCH);
    const values = chunk.map(r =>
      `('${esc(r.id)}','${esc(r.name)}','${esc(r.link)}','BUSINESS','${esc(r.phone)}','${esc(r.email)}')`
    ).join(",");

    runSQLVoid(`INSERT OR IGNORE INTO leads_clean (id,name,link,category,phone,email) VALUES ${values}`);
    inserted += chunk.length;
    process.stdout.write(`\r  Inserted ${inserted}/${businessRows.length}...`);
  }

  // 5. Verify
  console.log("\n");
  const verify = runSQL("SELECT COUNT(*) as n FROM leads_clean");
  console.log(`[Classifier] leads_clean confirmed: ${verify[0]?.n ?? 0} rows`);
  console.log("\n=== FINAL REPORT ===");
  console.log(`  BUSINESS  → leads_clean : ${counts.BUSINESS}`);
  console.log(`  MEDIA     → discarded   : ${counts.MEDIA}`);
  console.log(`  JUNK      → discarded   : ${counts.JUNK}`);
  console.log("====================\n");
}

main().catch(e => { console.error(e); process.exit(1); });
