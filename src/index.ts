export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
}

const TELEGRAM_CHAT_ID = "7726489288";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/leads") {
      return handleLeadIngestion(request, env);
    }

    return new Response("bakrayot-alpha-pulse is live", { status: 200 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendDailySummary(env));
  },
};

async function handleLeadIngestion(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const id = crypto.randomUUID();
  const businessId = (body.business_id as string) || "unknown";
  const leadData = JSON.stringify(body);

  await env.DB.prepare(
    "INSERT INTO leads (id, business_id, lead_data) VALUES (?, ?, ?)"
  )
    .bind(id, businessId, leadData)
    .run();

  return new Response(JSON.stringify({ success: true, id }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

async function sendDailySummary(env: Env): Promise<void> {
  const result = await env.DB.prepare(`
    SELECT business_id, COUNT(*) as total_leads
    FROM leads
    WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY business_id
    ORDER BY total_leads DESC
  `).all();

  const rows = result.results as Array<{ business_id: string; total_leads: number }>;

  let message: string;

  if (rows.length === 0) {
    message = "📊 *Alpha Pulse Daily Report*\n\nNo leads received in the past 24 hours.";
  } else {
    const totalAll = rows.reduce((sum, r) => sum + r.total_leads, 0);
    const lines = rows.map((r) => `• \`${r.business_id}\`: *${r.total_leads}* lead${r.total_leads !== 1 ? "s" : ""}`);
    message = `📊 *Alpha Pulse Daily Report*\n\n${lines.join("\n")}\n\n*Total: ${totalAll} leads in last 24h*`;
  }

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
    }),
  });
}
