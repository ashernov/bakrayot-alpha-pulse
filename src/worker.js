// ─── God Node — Thin-Client Control Plane ────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { method } = request;
    const path = url.pathname;

    if (method === 'GET' && path === '/health') {
      return Response.json({
        status: 'alive',
        pulse: '0010110',
        architecture: 'thin_client_god_node',
      });
    }

    if (method === 'POST' && path === '/bus') {
      return handleBus(request, env);
    }

    if (method === 'POST' && path === '/telegram') {
      return handleTelegram(request, env);
    }

    if (method === 'GET' && path === '/state') {
      return handleState(request, env);
    }

    return Response.json({ error: 'Not Found' }, { status: 404 });
  },
};

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

  const rawInput = typeof body.message === 'string' ? body.message : JSON.stringify(body);
  const source   = typeof body.source  === 'string' ? body.source  : 'pixel';

  const ai = await runAI(env, rawInput);
  const id = crypto.randomUUID();

  await env.DB.prepare(
    'INSERT INTO universal_memory (id, source, intent, raw_input, ai_response) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, source, ai.intent, rawInput, ai.response).run();

  if (ai.intent === 'hot_lead' || ai.intent === 'task') {
    await tgSend(
      env,
      env.ADMIN_CHAT_ID,
      `[${ai.intent.toUpperCase()}] ${source}\n\n${rawInput}\n\n→ ${ai.response}`
    );
  }

  return Response.json({ id, intent: ai.intent, response: ai.response });
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

  const chatId   = msg.chat?.id;
  const rawInput = typeof msg.text === 'string' ? msg.text : JSON.stringify(msg);

  const ai = await runAI(env, rawInput);
  const id = crypto.randomUUID();

  await env.DB.prepare(
    'INSERT INTO universal_memory (id, source, intent, raw_input, ai_response) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, 'telegram', ai.intent, rawInput, ai.response).run();

  if (chatId) {
    await tgSend(env, String(chatId), ai.response);
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

// ─── Workers AI ───────────────────────────────────────────────────────────────

async function runAI(env, rawInput) {
  const messages = [
    {
      role: 'system',
      content:
        'You are a tactical AI classifier. ' +
        'Classify the input into exactly one intent: hot_lead | task | memory_log | query. ' +
        'Then write a short tactical response (max 2 sentences). ' +
        'Reply ONLY with compact JSON: {"intent":"<intent>","response":"<response>"}',
    },
    { role: 'user', content: rawInput },
  ];

  try {
    const result = await env.AI.run('@cf/meta/llama-3-8b-instruct', { messages });
    const text   = result?.response ?? '';
    const match  = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.intent && parsed.response) return parsed;
    }
  } catch (err) {
    console.error('[ai] run failed:', err.message);
  }

  return { intent: 'memory_log', response: 'Logged.' };
}

// ─── Telegram send ────────────────────────────────────────────────────────────

async function tgSend(env, chatId, text) {
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
      console.error('[tg] send failed status=', res.status);
    }
  } catch (err) {
    console.error('[tg] send threw:', err.message);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function authKey(request, env) {
  const provided = request.headers.get('X-HUB-KEY') ?? '';
  const expected = env.HUB_AUTH_KEY ?? '';
  if (!expected || provided.length !== expected.length) return false;
  // constant-time comparison
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
