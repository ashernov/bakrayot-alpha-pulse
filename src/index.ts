// ═════════════════════════════════════════════════════════════════════════════
// bakrayot-alpha-pulse — hardened production build
// ═════════════════════════════════════════════════════════════════════════════

export interface Env {
  DB: D1Database;
  BOT_SESSIONS: KVNamespace;
  KV: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  LEADS_API_KEY: string;
  GROW_WEBHOOK_KEY: string;
  MORNING_API_ID: string;
  MORNING_API_SECRET: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const TELEGRAM_CHAT_ID   = "7726489288";
const SESSION_TTL        = 60 * 10;        // #4 — 10 min session TTL
const RATE_LIMIT_TTL     = 60;             // #6 — 1 /register per 60 s
const MAX_FREE_TEXT_LEN  = 500;            // #10 — max chars for territory/categories
const BUILD_TS           = "__BUILD_TS__"; // replaced at deploy time via wrangler var

type OnboardingStep = "territory" | "categories";
interface Session { step: OnboardingStep; territory?: string; }

interface TelegramUpdate {
  message?: {
    chat:  { id: number };
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Router
// ═════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // #8 — Guard: token must be non-empty before constructing webhook path
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.error("[boot] TELEGRAM_BOT_TOKEN is not set");
      return new Response("Service Unavailable", { status: 503 });
    }

    // #8 — Health endpoint
    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(env);
    }

    // Lead ingestion
    if (request.method === "POST" && url.pathname === "/leads") {
      return handleLeadIngestion(request, env);
    }

    // Grow webhook — financial closing loop
    if (request.method === "POST" && url.pathname === "/api/webhooks/grow") {
      return handleGrowWebhook(request, env);
    }

    // #7 — Webhook: only exact token path accepted; everything else → 200 (silent)
    if (request.method === "POST") {
      if (url.pathname === `/webhook/${env.TELEGRAM_BOT_TOKEN}`) {
        return handleTelegramWebhook(request, env);
      }
      if (url.pathname.startsWith("/webhook/")) {
        // Wrong or missing token suffix — silent 200, leak nothing
        console.warn("[security] Rejected webhook request with invalid token path");
        return new Response("OK");
      }
    }

    return new Response("bakrayot-alpha-pulse is live", { status: 200 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendDailySummary(env));
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// #8 — Health endpoint
// ═════════════════════════════════════════════════════════════════════════════

async function handleHealth(env: Env): Promise<Response> {
  const result = {
    status:    "ok" as "ok" | "degraded",
    timestamp: new Date().toISOString(),
    build:     BUILD_TS,
    checks: {
      d1:  { ok: false, latency_ms: 0, error: "" },
      kv:  { ok: false, latency_ms: 0, error: "" },
    },
  };

  // D1 ping
  const d1Start = Date.now();
  try {
    await env.DB.prepare("SELECT 1").first();
    result.checks.d1.ok = true;
  } catch (err) {
    result.checks.d1.error = (err as Error).message;
    result.status = "degraded";
  }
  result.checks.d1.latency_ms = Date.now() - d1Start;

  // KV ping
  const kvStart = Date.now();
  try {
    await env.BOT_SESSIONS.put("__healthcheck__", "1", { expirationTtl: 60 });
    await env.BOT_SESSIONS.delete("__healthcheck__");
    result.checks.kv.ok = true;
  } catch (err) {
    result.checks.kv.error = (err as Error).message;
    result.status = "degraded";
  }
  result.checks.kv.latency_ms = Date.now() - kvStart;

  const httpStatus = result.status === "ok" ? 200 : 503;
  return new Response(JSON.stringify(result, null, 2), {
    status:  httpStatus,
    headers: { "Content-Type": "application/json" },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Telegram webhook dispatcher
// ═════════════════════════════════════════════════════════════════════════════

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  // #2 — Parse; bad JSON → 200 silent (prevents Telegram retry storm)
  let body: TelegramUpdate;
  try {
    body = await request.json();
  } catch {
    console.warn("[webhook] Failed to parse JSON body — ignoring");
    return new Response("OK");
  }

  // #2 — Validate required fields
  const msg = body?.message;
  if (!msg || typeof msg !== "object") return new Response("OK");

  const chatId = msg.chat?.id;
  const userId = msg.from?.id;

  if (!chatId || typeof chatId !== "number" || chatId <= 0) return new Response("OK");
  if (!userId || typeof userId !== "number" || userId <= 0) return new Response("OK");

  const firstName = typeof msg.from?.first_name === "string" ? msg.from.first_name.slice(0, 64) : "";
  const rawText   = typeof msg.text === "string" ? msg.text.trim() : "";
  const command   = rawText.startsWith("/") ? rawText.split(" ")[0].toLowerCase() : null;

  // #1 — Top-level try/catch; always return 200
  try {
    if      (command === "/register") await handleRegister(env, chatId, userId, firstName);
    else if (command === "/cancel")   await handleCancel(env, chatId, userId);
    else                              await handleTextInput(env, chatId, userId, rawText);
  } catch (err) {
    console.error(`[bot] Unhandled error uid=${userId}:`, (err as Error).message, (err as Error).stack);
  }

  return new Response("OK");
}

// ═════════════════════════════════════════════════════════════════════════════
// Onboarding handlers
// ═════════════════════════════════════════════════════════════════════════════

async function handleRegister(
  env: Env, chatId: number, userId: number, firstName: string
): Promise<void> {

  // #6 — Rate limit: 1 /register per userId per 60 s
  const rlKey = `ratelimit:register:${userId}`;
  try {
    const existing = await env.BOT_SESSIONS.get(rlKey);
    if (existing) {
      await tgSend(env, chatId, "⏳ כבר שלחת בקשת רישום לאחרונה\\. המתן דקה ונסה שוב\\.");
      return;
    }
    await env.BOT_SESSIONS.put(rlKey, "1", { expirationTtl: RATE_LIMIT_TTL });
  } catch (err) {
    console.error(`[register] KV rate-limit check failed uid=${userId}:`, (err as Error).message);
    // Non-fatal — continue rather than block the user
  }

  // #4 — Clear any orphaned session before starting fresh
  try {
    await clearSession(env, userId);
  } catch (err) {
    console.warn(`[register] Failed to clear stale session uid=${userId}:`, (err as Error).message);
  }

  // #1/#5 — Upsert agent row
  try {
    await env.DB.prepare(
      `INSERT INTO agents (id, type, routing_rule, telegram_id)
       VALUES (?, 'human', 'auto', ?)
       ON CONFLICT(telegram_id) DO NOTHING`
    ).bind(`tg-${userId}`, String(userId)).run();
  } catch (err) {
    console.error(`[register] D1 upsert failed uid=${userId}:`, (err as Error).message);
    await tgSend(env, chatId, "⚠️ שגיאה פנימית\\. נסה שוב עוד רגע\\.");
    return;
  }

  // #4 — Open session with 10-min TTL
  try {
    await setSession(env, userId, { step: "territory" });
  } catch (err) {
    console.error(`[register] KV session write failed uid=${userId}:`, (err as Error).message);
    await tgSend(env, chatId, "⚠️ שגיאה פנימית\\. נסה שוב עוד רגע\\.");
    return;
  }

  await tgSend(env, chatId,
    `שלום ${esc(firstName)}\\! 👋\n\n` +
    `נרשום אותך כסוכן במערכת\\.\n\n` +
    `*שלב 1/2*\n` +
    `באיזה אזורים אתה פעיל?\n` +
    `_לדוגמה: תל אביב, גוש דן, השרון_`
  );
}

async function handleCancel(env: Env, chatId: number, userId: number): Promise<void> {
  try {
    await clearSession(env, userId);
  } catch (err) {
    console.warn(`[cancel] KV clear failed uid=${userId}:`, (err as Error).message);
  }
  await tgSend(env, chatId, "❌ הרישום בוטל\\. שלח /register כדי להתחיל מחדש\\.");
}

async function handleTextInput(
  env: Env, chatId: number, userId: number, text: string
): Promise<void> {

  // #2 — Input length guard
  if (text.length > MAX_FREE_TEXT_LEN) {
    await tgSend(env, chatId, `⚠️ הטקסט ארוך מדי \\(מקסימום ${MAX_FREE_TEXT_LEN} תווים\\)\\.`);
    return;
  }

  // #4 — Fetch session; KV errors treated as no-session
  let session: Session | null = null;
  try {
    session = await getSession(env, userId);
  } catch (err) {
    console.error(`[text] KV get failed uid=${userId}:`, (err as Error).message);
  }

  if (!session) {
    await tgSend(env, chatId,
      "שלח /register כדי להירשם כסוכן במערכת Biz\\.bakrayot\\.co\\.il 🏢"
    );
    return;
  }

  // ── Step 1: territory ────────────────────────────────────────────────────
  if (session.step === "territory") {
    if (text.length < 2) {
      await tgSend(env, chatId, "⚠️ אנא הכנס לפחות אזור אחד\\.");
      return;
    }
    try {
      await setSession(env, userId, { step: "categories", territory: text });
    } catch (err) {
      console.error(`[text] KV set failed uid=${userId}:`, (err as Error).message);
      await tgSend(env, chatId, "⚠️ שגיאה פנימית\\. נסה שוב\\.");
      return;
    }
    await tgSend(env, chatId,
      `✅ *אזורים נשמרו:* ${esc(text)}\n\n` +
      `*שלב 2/2*\n` +
      `באיזה קטגוריות עסקים אתה מתמחה?\n` +
      `_לדוגמה: אינסטלציה, חשמל, שיפוצים_`
    );
    return;
  }

  // ── Step 2: categories → commit to D1 ───────────────────────────────────
  if (session.step === "categories") {
    if (text.length < 2) {
      await tgSend(env, chatId, "⚠️ אנא הכנס לפחות קטגוריה אחת\\.");
      return;
    }

    const territory  = session.territory!;
    const categories = text;

    let changes = 0;
    try {
      const result = await env.DB.prepare(
        `UPDATE agents SET territory = ?, categories = ? WHERE telegram_id = ?`
      ).bind(territory, categories, String(userId)).run();
      changes = result.meta.changes ?? 0;
    } catch (err) {
      console.error(`[onboarding] D1 update failed uid=${userId}:`, (err as Error).message);
      await tgSend(env, chatId, "⚠️ שגיאה בשמירה\\. נסה שוב\\.");
      return;
    }

    // Always clear session — even on 0 changes to avoid loops
    try {
      await clearSession(env, userId);
    } catch (err) {
      console.warn(`[onboarding] KV clear failed uid=${userId}:`, (err as Error).message);
    }

    if (changes === 0) {
      console.error(`[onboarding] 0 rows updated — agent missing uid=${userId}`);
      await tgSend(env, chatId, "⚠️ לא נמצאה רשומת סוכן\\. אנא פנה למנהל המערכת\\.");
      return;
    }

    // #9 — Onboarding completion log
    console.log(`[onboarding] COMPLETE uid=${userId} territory="${territory}" categories="${categories}"`);

    await tgSend(env, chatId,
      `🎉 *הרישום הושלם בהצלחה\\!*\n\n` +
      `🗺 אזורים: *${esc(territory)}*\n` +
      `🏷 קטגוריות: *${esc(categories)}*\n\n` +
      `אתה כעת פעיל במערכת ותקבל לידים בהתאם להגדרות שלך\\.`
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Lead ingestion
// ═════════════════════════════════════════════════════════════════════════════

async function handleLeadIngestion(request: Request, env: Env): Promise<Response> {
  // Auth
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token || token !== env.LEADS_API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  // #2 — Parse body
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // #2 — Validate required fields
  const businessId = typeof body.business_id === "string" && body.business_id.trim()
    ? body.business_id.trim().slice(0, 128)
    : null;
  if (!businessId) {
    return new Response(JSON.stringify({ error: "business_id is required" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // #5 — Validate assigned_to FK if present
  const assignedTo = typeof body.assigned_to === "string" ? body.assigned_to.trim() : null;
  if (assignedTo) {
    try {
      const agent = await env.DB.prepare(
        "SELECT id FROM agents WHERE id = ? AND active = 1"
      ).bind(assignedTo).first();
      if (!agent) {
        return new Response(JSON.stringify({ error: `assigned_to agent '${assignedTo}' not found or inactive` }), {
          status: 422, headers: { "Content-Type": "application/json" },
        });
      }
    } catch (err) {
      console.error("[leads] FK validation failed:", (err as Error).message);
      return new Response(JSON.stringify({ error: "Database error" }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  const id       = crypto.randomUUID();
  const leadData = JSON.stringify(body);

  // #1 — D1 insert wrapped
  try {
    await env.DB.prepare(
      "INSERT INTO leads (id, business_id, lead_data) VALUES (?, ?, ?)"
    ).bind(id, businessId, leadData).run();
  } catch (err) {
    console.error(`[leads] D1 insert failed business_id=${businessId}:`, (err as Error).message);
    return new Response(JSON.stringify({ error: "Database error" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // #9 — Lead insert log
  console.log(`[leads] INSERT id=${id} business_id=${businessId} assigned_to=${assignedTo ?? "none"} source=${body.source ?? "api"}`);

  return new Response(JSON.stringify({ success: true, id }), {
    status: 201, headers: { "Content-Type": "application/json" },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Daily summary cron
// ═════════════════════════════════════════════════════════════════════════════

async function sendDailySummary(env: Env): Promise<void> {
  let rows: Array<{ business_id: string; total_leads: number }> = [];

  // #1 — D1 wrapped
  try {
    const result = await env.DB.prepare(`
      SELECT business_id, COUNT(*) as total_leads
      FROM leads
      WHERE created_at >= datetime('now', '-24 hours')
      GROUP BY business_id
      ORDER BY total_leads DESC
    `).all();
    rows = result.results as typeof rows;
  } catch (err) {
    console.error("[cron] D1 query failed:", (err as Error).message);
    return;
  }

  let message: string;
  if (rows.length === 0) {
    message = "📊 *Alpha Pulse Daily Report*\n\nNo leads received in the past 24 hours.";
  } else {
    const totalAll = rows.reduce((sum, r) => sum + r.total_leads, 0);
    const lines    = rows.map(
      (r) => `• \`${r.business_id}\`: *${r.total_leads}* lead${r.total_leads !== 1 ? "s" : ""}`
    );
    message = `📊 *Alpha Pulse Daily Report*\n\n${lines.join("\n")}\n\n*Total: ${totalAll} leads in last 24h*`;
  }

  // #1 — tgSend wrapped
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("[cron] Telegram send failed:", (err as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// KV session helpers
// ═════════════════════════════════════════════════════════════════════════════

const sessionKey = (userId: number) => `session:${userId}`;

async function getSession(env: Env, userId: number): Promise<Session | null> {
  const raw = await env.BOT_SESSIONS.get(sessionKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

async function setSession(env: Env, userId: number, data: Session): Promise<void> {
  await env.BOT_SESSIONS.put(sessionKey(userId), JSON.stringify(data), {
    expirationTtl: SESSION_TTL, // #4 — 10 min
  });
}

async function clearSession(env: Env, userId: number): Promise<void> {
  await env.BOT_SESSIONS.delete(sessionKey(userId));
}

// ═════════════════════════════════════════════════════════════════════════════
// Telegram send helper — never throws
// ═════════════════════════════════════════════════════════════════════════════

async function tgSend(env: Env, chatId: number, text: string): Promise<void> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2" }),
      }
    );
    if (!res.ok) {
      const err = await res.text().catch(() => "unreadable");
      console.error(`[tg] sendMessage failed status=${res.status} chat=${chatId}: ${err}`);
    }
  } catch (err) {
    console.error(`[tg] sendMessage threw chat=${chatId}:`, (err as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Utility: safeCompare — constant-time string comparison (no crypto import)
// ═════════════════════════════════════════════════════════════════════════════

function safeCompare(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.byteLength; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// Utility: fetchWithTimeout — 8 s hard limit via AbortController
// ═════════════════════════════════════════════════════════════════════════════

function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  return Promise.race([
    fetch(url, { ...options, signal: controller.signal }).then((res) => {
      clearTimeout(timer);
      return res;
    }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => {
        controller.abort();
        reject(new Error("fetchWithTimeout: request timed out after 8000ms"));
      }, 8000)
    ),
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// Morning API — generate legal green invoice document
// ═════════════════════════════════════════════════════════════════════════════

async function generateLegalDocument(
  env: Env,
  token: string,
  transactionCode: string,
  amount: number
): Promise<void> {
  const res = await fetchWithTimeout(
    "https://api.greeninvoice.co.il/api/v1/documents",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        type: 320,                    // Green Invoice: tax invoice receipt
        lang: "he",
        currency: "ILS",
        vatType: 0,
        income: [
          {
            catalogNum: transactionCode,
            description: `עסקה ${transactionCode}`,
            quantity: 1,
            price: amount,
            currency: "ILS",
            vatType: 0,
          },
        ],
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "unreadable");
    throw new Error(`[grow] Morning API error status=${res.status}: ${text}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/webhooks/grow — financial closing loop (7 steps)
// ═════════════════════════════════════════════════════════════════════════════

async function handleGrowWebhook(request: Request, env: Env): Promise<Response> {
  try {
    // Step 1 — authenticate via webhookKey in body
    let rawBody: Record<string, unknown>;
    try {
      rawBody = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    const webhookKey = typeof rawBody.webhookKey === "string" ? rawBody.webhookKey : "";
    if (!safeCompare(webhookKey, env.GROW_WEBHOOK_KEY)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }

    // Step 2 — parse payload
    const transactionCode = typeof rawBody.transactionCode === "string"
      ? rawBody.transactionCode.trim()
      : null;
    const amount = typeof rawBody.amount === "number" ? rawBody.amount : null;

    if (!transactionCode || amount === null) {
      return new Response(JSON.stringify({ error: "transactionCode (string) and amount (number) are required" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    // Step 3 — idempotency check
    const idemKey = `idem:${transactionCode}`;
    const idemVal = await env.KV.get(idemKey);
    if (idemVal) {
      return new Response(JSON.stringify({ success: true, idempotent: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    // Step 4 — get or refresh Morning API token
    let morningToken = await env.KV.get("morning:token");
    if (!morningToken) {
      const authRes = await fetchWithTimeout(
        "https://api.greeninvoice.co.il/api/v1/account/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: env.MORNING_API_ID, secret: env.MORNING_API_SECRET }),
        }
      );
      if (!authRes.ok) {
        const text = await authRes.text().catch(() => "unreadable");
        throw new Error(`[grow] Morning auth failed status=${authRes.status}: ${text}`);
      }
      const authData = await authRes.json() as { token?: string };
      if (!authData.token) {
        throw new Error("[grow] Morning auth response missing token field");
      }
      morningToken = authData.token;
      await env.KV.put("morning:token", morningToken, { expirationTtl: 3300 });
    }

    // Step 5 — generate legal document (green invoice)
    await generateLegalDocument(env, morningToken, transactionCode, amount);

    // Step 6 — D1 batch: deduct agent balance + mark lead as WON
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE agents SET balance = balance - (? * 0.10) WHERE id = (SELECT assigned_to FROM leads_clean WHERE transaction_code = ?)`
      ).bind(amount, transactionCode),
      env.DB.prepare(
        `UPDATE leads_clean SET status = 'WON', updated_at = CURRENT_TIMESTAMP WHERE transaction_code = ?`
      ).bind(transactionCode),
    ]);

    // Step 7 — mark idempotency key and return success
    await env.KV.put(idemKey, "done", { expirationTtl: 2592000 });

    console.log(`[grow] CLOSED transactionCode=${transactionCode} amount=${amount}`);

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    const err = error as Error;
    await env.KV.put(`errors:${Date.now()}`, err.stack ?? err.message);
    throw error;
  }
}

// ── MarkdownV2 escape ─────────────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}
