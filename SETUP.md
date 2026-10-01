# Infinite AI — setup

## Pick a backend first

There are two, and they use the same request and response shape, so the frontend is the same
either way.

| Backend | Cost | Use it when |
| --- | --- | --- |
| `functions/index.js` (Cloud Function + Gemini) | Needs the **Blaze** plan; Blaze's free quota covers small projects | You are happy to add a billing card |
| `ai-space/app.py` (private Hugging Face Space) | Free, no card, but slower and rate-limited | You want to stay on the Firebase free plan |

Skip to "Free backend (Hugging Face Space)" if you are not upgrading to Blaze.

Files (copy into your repo, same paths):

| File | Status |
| --- | --- |
| `firebase.json` | NEW (repo root) |
| `.firebaserc` | NEW (repo root) |
| `functions/index.js` | NEW |
| `functions/package.json` | NEW |
| `static/js/ai-chat.js` | NEW |
| `ai/index.html` | NEW (the full Infinite AI workspace) |
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

## Free backend (Hugging Face Space)

This keeps the project on the Firebase free plan, so no billing card is needed. Full detail
lives in `ai-space/README.md`; the short version:

1. Create a **private** Space at <https://huggingface.co/new-space>, SDK **Docker**, and upload
   `ai-space/app.py`, `ai-space/requirements.txt` and `ai-space/Dockerfile`.
2. Create a read token at <https://huggingface.co/settings/tokens>.
3. Create a Firebase service-account key (Project settings → Service accounts → *Generate new
   private key*).
4. In the Space, add two **Secrets** (not variables): `HF_TOKEN` and `FIREBASE_SERVICE_ACCOUNT`
   (the whole JSON on one line), then restart the Space.
5. Check <https://you-space.hf.space/health> returns `"has_token": true` and `"has_firebase": true`.
6. Set the URL in `ai/index.html`:
   ```js
   var SPACE_URL = 'https://<you>-<space>.hf.space';
   ```

Leave `SPACE_URL` empty to keep using the Cloud Function. The Space verifies the user's
Firebase ID token, so it only ever answers for a signed-in user, and it never writes to
Firestore: the browser applies approved changes to localStorage as before.