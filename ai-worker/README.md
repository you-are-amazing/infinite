# Infinite AI — Cloudflare Worker backend

Free hosting for the Infinite AI assistant, so the project can stay on the Firebase free
plan. It replaces `functions/index.js` (which needs the Blaze plan). A Hugging Face Space was
the first home for this backend, but Docker Spaces on the free CPU tier now require a PRO
subscription.

`src/index.js` keeps the same request and response shape as the Cloud Function, so the
frontend only changes one URL.

```
POST https://infinite-ai.<you>.workers.dev/chat
Authorization: Bearer <Firebase ID token>

{ "messages": [{ "role": "user" | "model", "text": "..." }],
  "today": "2026-10-01",
  "data": { "goals": [...], "notes": [...], "links": [...] } }

200 { "reply": "markdown", "proposed": [{ "name": "propose_goal", "args": { ... } }] }
401 not signed in   ·   429 daily cap or the free inference endpoint is busy
```

## One-time setup

1. Create a Cloudflare account (free) at <https://dash.cloudflare.com/sign-up>, then install
   the CLI and log in:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
2. Copy the template and fill it in: `cp wrangler.example.toml wrangler.toml`, then put your **Firebase Web API key**
   next to `FIREBASE_API_KEY`. `wrangler.toml` is gitignored, so your own values are never committed.
   It is not a secret — it is already visible in your site's JavaScript — but the Worker
   needs it to verify the signed-in user with Google Identity Toolkit.
3. Add the model provider token as a Worker secret (create one at
   <https://huggingface.co/settings/tokens>):
   ```bash
   cd ai-worker && npx wrangler secret put HF_TOKEN
   ```
4. Deploy:
   ```bash
   cd ai-worker && npx wrangler deploy
   ```
5. Check it: `curl https://infinite-ai.<you>.workers.dev/health` should show
   `"hasToken": true` and `"hasFirebaseKey": true`.
6. Point the frontend at it in `ai/index.html`:
   ```js
   var AI_ENDPOINT = 'https://infinite-ai.<you>.workers.dev';
   ```
   Leave it empty to keep using the Firebase callable.

## Vars and secrets

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `HF_TOKEN` | secret (`npx wrangler secret put HF_TOKEN`) | — | Token from <https://huggingface.co/settings/tokens>. Required. |
| `FIREBASE_API_KEY` | var | — | Your Firebase Web API key. Public, and used only to verify the caller's ID token. |
| `HF_MODEL` | var | `Qwen/Qwen3-4B-Instruct-2507` | Any chat model the HF router serves on a free provider. If a provider withdraws it, the Worker falls back to the next model in its built-in list. |
| `DAILY_LIMIT` | var | `40` | Messages per user per UTC day. |
| `ALLOWED_ORIGINS` | var | GitHub Pages + `localhost:5500/5501` | Comma-separated CORS origins. |

## What it does

- Verifies the caller's Firebase ID token, so only a signed-in user of your project gets answers.
- Puts the caller's goals, notes and saved links into the prompt as a snapshot, then asks the
  Hugging Face router for a JSON answer and validates every proposal before returning it. A
  made-up goal id, an invented YouTube URL or an unknown tool name is dropped.
- Never writes to Firestore. The browser shows a confirm card and applies the change to
  localStorage, so your existing sync carries it, exactly as with the Cloud Function.
- CORS is limited to the origins in `ALLOWED_ORIGINS`.

## Limits worth knowing

- Free Workers: 100,000 requests a day. Each chat message is one request.
- Free Spaces are gone, so there is no 10–40s cold start here — Workers start in milliseconds.
- Free inference is the real ceiling: it is rate-limited across your account, and when it is
  busy the user sees "The free AI endpoint is busy right now."
- The daily cap is an in-memory map inside the Worker isolate, so it is a guard rail rather
  than exact accounting. Move it to Firestore or a KV binding if you need it to be strict.
- Only your own data is involved, but it does travel to Cloudflare and Hugging Face. If that
  matters for your users, say so somewhere on the page.