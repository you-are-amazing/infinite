---
title: Infinite AI
emoji: ♾️
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
license: mit
private: true
---

# Infinite AI — backend

This Space replaces the Firebase Cloud Function for Infinite AI, so the assistant keeps
working on the Firebase free plan. The code in this folder is the whole backend: it verifies
the signed-in user with a Firebase ID token, reads that user's goals and notes from
Firestore, asks a Hugging Face inference model for an answer, and returns it with any
proposals. It never writes to Firestore — the browser shows a confirm card and applies
changes to localStorage, exactly as before.

## One-time setup

1. Create a **private** Space: <https://huggingface.co/new-space>, choose **Docker**, and
   upload the contents of this folder (`app.py`, `requirements.txt`, `Dockerfile`).
2. Create a Hugging Face read token at <https://huggingface.co/settings/tokens>
   (Fine-grained → Read access to inference providers is enough).
3. Create a Firebase service account key: Firebase console → Project settings → Service
   accounts → *Generate new private key*. It downloads a JSON file. In the Space go to
   **Settings → Variables and secrets** and add two **Secrets** (not plain variables):
   - `HF_TOKEN` — the Hugging Face token from step 2.
   - `FIREBASE_SERVICE_ACCOUNT` — the whole contents of the JSON file on **one line**.
4. Restart the Space (it rebuilds), then open
   `https://<you>-<space>.hf.space/health`. You want `"has_token": true` and
   `"has_firebase": true`.
5. Copy the Space URL into `ai/index.html`:
   ```js
   var SPACE_URL = 'https://<you>-<space>.hf.space';
   ```

## Optional secrets

| Secret | Default | What it does |
| --- | --- | --- |
| `HF_MODEL` | `Qwen/Qwen2.5-7B-Instruct` | Any chat model served by the HF router. |
| `DAILY_LIMIT` | `40` | Messages per user per UTC day. |
| `ALLOWED_ORIGINS` | GitHub Pages + `localhost:5500/5501` | Comma-separated CORS origins. Add your own origin if you serve the site elsewhere. |

## Notes and limits

- Free Spaces sleep when idle, so the **first** message after a pause can take 10–40
  seconds. The client shows a typing indicator, so it reads as slow rather than broken.
- Free inference is rate-limited across the whole Space. If a user burns through it, they
  get the same "the free AI endpoint is busy" message everyone else gets.
- `propose_complete_goal` only works for goals already in the user's data, and proposals are
  validated in this file, so the model cannot make one up.
- The daily cap lives in the `ai_usage` collection, the same place the Cloud Function used.