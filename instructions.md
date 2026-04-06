# MISSION: Implement `POST /api/webhooks/grow` (Financial Closing Loop)

You are an expert Cloudflare Workers (TypeScript) developer. Your task is to implement a secure, idempotent webhook endpoint inside the existing `src/index.ts`.
Project: `bakrayot-alpha-pulse`

## 1. Global Constraints & Architecture
- **Single File Context:** All logic must be contained in `src/index.ts`. Do not create multiple files or sub-workers.
- **No Node.js Crypto:** Do NOT import `crypto` or `node:crypto`.
- **Environment:** All secrets and bindings must be accessed via the `env` object.

## 2. Environment Variables & Types
Ensure the `Env` interface at the top of the file includes exactly:
```typescript
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  GROW_WEBHOOK_KEY: string;
  MORNING_API_ID: string;
  MORNING_API_SECRET: string;
}
```

## 3. Mandatory Utility Functions

### A. `safeCompare(a: string, b: string): boolean`
1. Convert both strings using `new TextEncoder().encode()`
2. If byte lengths mismatch, return `false`
3. Loop with bitwise XOR (`^`), accumulate with `|=`
4. Return `true` if accumulated result is `0`

### B. `fetchWithTimeout(url: string, options?: RequestInit): Promise<Response>`
1. `Promise.race` with 8000ms limit
2. Use `AbortController` — call `controller.abort()` on timeout
3. Call `clearTimeout` if fetch resolves before timeout

## 4. Webhook Flow (`POST /api/webhooks/grow`)

**Step 1:** safeCompare(body.webhookKey, env.GROW_WEBHOOK_KEY) → 401 if false
**Step 2:** Parse JSON — expect `{ transactionCode: string, amount: number }`
**Step 3:** KV get `idem:{transactionCode}` → return 200 if exists
**Step 4:** KV get `morning:token` → if missing, fetch from Morning API, store TTL 3300s
**Step 5:** generateLegalDocument() via Morning Green Invoice API
**Step 6:** D1 batch:
  - UPDATE agents SET balance = balance - (? * 0.10) WHERE id = (SELECT assigned_to FROM leads_clean WHERE transaction_code = ?)
  - UPDATE leads_clean SET status = 'WON', updated_at = CURRENT_TIMESTAMP WHERE transaction_code = ?
**Step 7:** KV put `idem:{transactionCode}` = 'done', TTL 2592000 → return 200

## 5. Error Handler
- KV put `errors:{Date.now()}` = error.stack
- throw error (do NOT return 500 — let Cloudflare retry)

After implementation: run `wrangler deploy` and report deploy URL + git commit hash.
