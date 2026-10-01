# Infinite AI — setup

## Pick a backend first

There are two, and they use the same request and response shape, so the frontend is the same
either way.

| Backend | Cost | Use it when |
| --- | --- | --- |
| `functions/index.js` (Cloud Function + Gemini) | Needs the **Blaze** plan; Blaze's free quota covers small projects | You are happy to add a billing card |
| `ai-worker/` (Cloudflare Worker + Hugging Face inference) | Free, no card | You want to stay on the Firebase free plan |

Skip to "Free backend (Cloudflare Worker)" if you are not upgrading to Blaze.

A option was tried and dropped: hosting on a Hugging Face Space is free no longer, since
Docker Spaces on the free CPU tier now require a PRO subscription.

Files (copy into your repo, same paths):

| File | Status |
| --- | --- |
| `firebase.json` | NEW (repo root) |
| `.firebaserc` | NEW (repo root) |
| `functions/index.js` | NEW |
| `functions/package.json` | NEW |
| `static/js/ai-chat.js` | NEW |
| `ai/index.html` | NEW (the full Infinite AI workspace) |
| `ai-worker/` | NEW (the free backend, if you are not upgrading to Blaze) |
| `index.html` | UPDATED (2 new `<script>` lines) |

## 1. One-time Firebase setup

1. Firebase console > upgrade project `life-is-short-bcf81` to the **Blaze** plan (needed for Cloud Functions).
   Add a budget alert (Google Cloud console > Billing > Budgets).
2. Get a Gemini API key from <https://aistudio.google.com/apikey>

## 2. Deploy the backend

```bash
npm install -g firebase-tools
firebase login
cd functions && npm install && cd ..
firebase functions:secrets:set GEMINI_API_KEY     # paste the key when asked
firebase deploy --only functions
```

If `firebase deploy` complains about the Node version, change `"node": "22"` in `functions/package.json`
to a version it lists as supported.

## 3. Publish the frontend

Commit and push the new/updated files. GitHub Pages serves them as before.
Sign in on the site; an infinity-symbol button appears at the bottom right.

## Other pages

`index.html` is the only page wired up. To add the chat to `notepad/`, `team/` or `calendar/`, add these two
lines after the other Firebase scripts and `team-notify.js` (note the `../`):

```html
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-functions-compat.js" defer></script>
<script src="../static/js/ai-chat.js?v=1" defer></script>
```

## Knobs (`functions/index.js`)

`REGION`, `MODEL`, `DAILY_LIMIT` (default 40 messages per user per day), `ALLOWED_ORIGINS`.
If you change `REGION`, change it in `static/js/ai-chat.js` too.

## Troubleshooting

- **"not deployed yet or unreachable"**: deploy step failed, or `REGION` differs between the two files.
- **CORS error in the console**: your site's origin is missing from `ALLOWED_ORIGINS`.
- **Button missing**: you are in guest mode (the AI is signed-in only on purpose).
- Server errors: `firebase functions:log`

## Free backend (Cloudflare Worker)

This keeps the project on the Firebase free plan, so no billing card is needed. Full detail
lives in `ai-worker/README.md`; the short version:

1. Create a free Cloudflare account at <https://dash.cloudflare.com/sign-up>, then:
   ```bash
   npm install -g wrangler && wrangler login
   ```
2. Put your **Firebase Web API key** in `ai-worker/wrangler.toml` next to `FIREBASE_API_KEY`
   (Project settings → Your apps → Web API key). It is public in your site's JS anyway; the
   Worker needs it to verify the signed-in user.
3. Add the model provider token as a Worker secret:
   ```bash
   cd ai-worker && npx wrangler secret put HF_TOKEN
   ```
4. `cd ai-worker && npx wrangler deploy`
5. Check `https://infinite-ai.<you>.workers.dev/health` returns `"hasToken": true` and
   `"hasFirebaseKey": true`.
6. Set the URL in `ai/index.html`:
   ```js
   var AI_ENDPOINT = 'https://infinite-ai.<you>.workers.dev';
   ```

Leave `AI_ENDPOINT` empty to keep using the Cloud Function. Either way the user only sends their
Firebase ID token plus their own goals and notes, and nothing is written back to Firestore: the
browser applies approved changes to localStorage as before.