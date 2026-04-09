// ─── God Node — Thin-Client Control Plane v1 ─────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method;
    const path   = url.pathname;

    if (method === 'GET'  && path === '/health')   return handleHealth();
    if (method === 'POST' && path === '/bus')       return handleBus(request, env);
    if (method === 'POST' && path === '/telegram')  return handleTelegram(request, env);
    if (method === 'GET'  && path === '/state')     return handleState(request, env);

    return Response.json({ error: 'Not Found' }, { status: 404 });
  },
};

// ─── GET /health ──────────────────────────────────────────────────────────────

function handleHealth() {
  return Response.json({
    status:       'alive',
    pulse:        '0010110',
    architecture: 'thin_client_god_node',
  });
}

// ─── POST /bus ────────────────────────────────────────────────────────────────

async function handleBus(request, env) {
  if (!authKey(request, env)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const rawInput = typeof body.message   === 'string' ? body.message   : JSON.stringify(body);
  const source   = typeof body.source    === 'string' ? body.source    : 'pixel';
  const sourceId = typeof body.source_id === 'string' ? body.source_id : crypto.randomUUID();

  const result = await handleInput(env, { source, sourceId, rawInput });
  return Response.json(result);
}

// ─── POST /telegram ───────────────────────────────────────────────────────────

async function handleTelegram(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('OK');
  }

  const msg = body?.message;
  if (!msg) return new Response('OK');

  const chatId   = String(msg.chat?.id ?? '');
  const sourceId = String(msg.message_id ?? crypto.randomUUID());
  const rawInput = typeof msg.text === 'string' ? msg.text : JSON.stringify(msg);

  if (!rawInput) return new Response('OK');

  const result = await handleInput(env, { source: 'telegram', sourceId, rawInput });

  if (chatId && result.status === 'ok') {
    await tgSend(env, chatId, result.response);
  }

  return new Response('OK');
}

// ─── GET /state ───────────────────────────────────────────────────────────────

async function handleState(request, env) {
  if (!authKey(request, env)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await env.DB.prepare(
    'SELECT * FROM universal_memory ORDER BY timestamp DESC LIMIT 50'
  ).all();

  return Response.json({ rows: result.results });
}

// ─── Core loop ────────────────────────────────────────────────────────────────

async function handleInput(env, { source, sourceId, rawInput }) {
  const id     = crypto.randomUUID();
  const dedupe = await dedupeKey(source, sourceId, rawInput);

  // Idempotency: return existing record if already processed
  try {
    const existing = await env.DB.prepare(
      'SELECT id, intent, ai_response FROM universal_memory WHERE dedupe_key = ?'
    ).bind(dedupe).first();

    if (existing) {
      return {
        id:       existing.id,
        intent:   existing.intent,
        response: existing.ai_response,
        status:   'ok',
        dedupe:   true,
      };
    }
  } catch (err) {
    console.error('[dedupe] lookup failed:', err.message);
  }

  // Run AI classification
  const ai = await runAI(env, rawInput);

  // Persist to D1 — handle UNIQUE race condition
  try {
    await env.DB.prepare(
      `INSERT INTO universal_memory
         (id, dedupe_key, source, source_id, intent, raw_input, ai_response, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ok')`
    ).bind(id, dedupe, source, sourceId, ai.intent, rawInput, ai.response).run();
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.message.includes('unique')) {
      // Race: another request won — fetch and return the winner
      const winner = await env.DB.prepare(
        'SELECT id, intent, ai_response FROM universal_memory WHERE dedupe_key = ?'
      ).bind(dedupe).first().catch(() => null);

      if (winner) {
        return {
          id:       winner.id,
          intent:   winner.intent,
          response: winner.ai_response,
          status:   'ok',
          dedupe:   true,
        };
      }
    }

    // Non-dedupe error — record it
    const errId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO universal_memory
         (id, dedupe_key, source, source_id, intent, raw_input, status, error_message)
       VALUES (?, ?, ?, ?, 'memory_log', ?, 'error', ?)`
    ).bind(errId, dedupe + ':err', source, sourceId, rawInput, err.message).run().catch(() => {});

    console.error('[d1] insert failed:', err.message);
    return { id: errId, intent: 'memory_log', response: 'Error logged.', status: 'error' };
  }

  // Emit downstream actions
  await emitNext(env, { source, ai, rawInput });

  return { id, intent: ai.intent, response: ai.response, status: 'ok' };
}

// ─── Emit downstream ──────────────────────────────────────────────────────────

async function emitNext(env, { source, ai, rawInput }) {
  if (ai.intent === 'hot_lead' || ai.intent === 'task') {
    await tgSend(
      env,
      env.ADMIN_CHAT_ID,
      `[${ai.intent.toUpperCase()}] via ${source}\n\n${rawInput}\n\n→ ${ai.response}`
    );
  }
}

// ─── Workers AI ───────────────────────────────────────────────────────────────

async function runAI(env, rawInput) {
  const messages = [
    {
      role: 'system',
      content:
        'You are a tactical AI classifier and responder. ' +
        'Classify the input into exactly one intent: hot_lead | task | memory_log | query. ' +
        'Generate a short tactical response (max 2 sentences). ' +
        'Reply ONLY with compact JSON — no markdown, no code fences: ' +
        '{"intent":"<intent>","response":"<response>"}',
    },
    { role: 'user', content: rawInput },
  ];

  try {
    const result = await env.AI.run('@cf/meta/llama-3-8b-instruct', { messages });
    const text   = result?.response ?? '';
    // Extract first valid JSON object from response
    const match  = text.match(/\{[^{}]*"intent"[^{}]*"response"[^{}]*\}/s);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const VALID_INTENTS = new Set(['hot_lead', 'task', 'memory_log', 'query']);
      if (VALID_INTENTS.has(parsed.intent) && typeof parsed.response === 'string') {
        return { intent: parsed.intent, response: parsed.response.slice(0, 500) };
      }
    }
  } catch (err) {
    console.error('[ai] run failed:', err.message);
  }

  return { intent: 'memory_log', response: 'Logged.' };
}

// ─── Telegram send ────────────────────────────────────────────────────────────

async function tgSend(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: chatId, text }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[tg] send failed status=', res.status, body);
    }
  } catch (err) {
    console.error('[tg] send threw:', err.message);
  }
}

// ─── Dedupe key (SHA-256) ─────────────────────────────────────────────────────

async function dedupeKey(source, sourceId, rawInput) {
  const data = `${source}:${sourceId}:${rawInput}`;
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Auth (constant-time) ─────────────────────────────────────────────────────

function authKey(request, env) {
  const provided = request.headers.get('X-HUB-KEY') ?? '';
  const expected = env.HUB_AUTH_KEY ?? '';
  if (!expected || provided.length !== expected.length) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
