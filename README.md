# Infinite

**We deserve better.**

Infinite is a free goal and progress tracker that runs entirely in the browser. Track your year, month and week, set daily to yearly goals, plan on a life calendar, take notes, work with friends in teams, and get motivational stories and songs picked for your goals.

Live site: https://you-are-amazing.github.io/infinite/

## Features

- **Progress dashboard**: live progress for the year, quarter, month and week, with a quote of the day.
- **Goals**: daily, weekly, monthly and yearly goals with a habit tracker sheet.
- **Life Calendar**: see your whole year at a glance.
- **Notepad & Docs**: rich text notes with highlighting. Notes you share with a team stay in sync both ways — a teammate's edit is merged back into your original note and tagged with who changed it.
- **Team Goals**: create or join a team with an invite code, share goals, chat and cheer each other on. Shared docs open from a chat bubble in a big live popup showing exactly what each member is allowed to do.
- **Inspire Feed**: paste any YouTube video or song link under **My Links** and it shows as a clickable thumbnail (click to open on YouTube). Also motivational stories and song previews matched to your goals, updated automatically.
- **Connect**: a message form for recruiters and builders. Each sender sees their own messages, can edit or
  delete what they sent, and every reply leaves from your own mail app (`mailto:`) — there is no inbox to answer from.
- **Private inbox** (`admin/`): every message in one list with All/Unread filters and search. Reachable only by the
  account that owns the site, and only after a key you set.
- **Infinite AI**: a coaching companion that reads your goals, notes and saved links, and can *propose* changes to
  them. Nothing is ever written without your confirmation.
- **Accounts and cloud sync**: email login with Firebase, or use it as a guest without an account. Sign-in, sign-up
  and password reset sit behind a Cloudflare Turnstile captcha, checked by the Worker — see
  [Captcha setup](#captcha-setup).
- **Light and dark mode**, responsive on desktop and mobile.

## Tech

Plain HTML, CSS and JavaScript. Firebase Authentication and Firestore for accounts and sync. GitHub Pages for hosting
and GitHub Actions for the Inspire Feed. The AI runs on a Cloudflare Worker (free tier) so the project can stay on the
Firebase free plan. No build step.

## Run locally

Open the folder in VS Code and start the **Live Server** extension, or run any static server:

```
python3 -m http.server 5500
```

Then visit http://127.0.0.1:5500

## Deploy

1. Push the code to the `main` branch.
2. In **Settings > Pages**, choose **Deploy from a branch**, then `main` and `/ (root)`.
3. Every push to `main` is published automatically at `https://<username>.github.io/<repo>/`.

## Firebase setup

1. Create a Firebase project and register a web app.
2. Paste the web config into `static/js/auth.js`.
3. Enable **Authentication > Sign-in method > Email/Password**.
4. Add your `<username>.github.io` domain under **Authentication > Settings > Authorized domains**.
5. Create a **Firestore** database. The rules are **`firestore.rules`**, but the committed copy is a *template*:
   `owner@example.com` stands in for your own account, so the admin address stays out of this repository. The real
   one lives in **`firestore.rules.deploy`**, which is gitignored and never pushed.
6. To publish, put the real address back and deploy:

   ```bash
   cp firestore.rules.deploy firestore.rules
   firebase deploy --only firestore
   ```

   Skipping step 6 is how the admin inbox ends up shut for everybody — you included. After deploying you can put
   the template back (`git checkout firestore.rules`) before your next commit.

> The Firebase Web API key ships in every page that uses Firebase, and the site's JavaScript has to name the admin
> account so the browser can draw the admin UI — so neither is treated as a secret here. Knowing the address is not
> access: every admin-only rule also requires the request to come from a signed-in session on that account. Real
> secrets (the AI provider token, the Gemini key) are never committed — see
> [Not in this repo](#not-in-this-repo).

The template's own header says the same thing:

```
// Firestore security rules for Infinite.
//
// PUBLIC COPY: owner@example.com below is a placeholder for your own account — the one
// allowed to read every message and to hold the developer key. The copy you deploy lives
// in firestore.rules.deploy (gitignored), with the real address in it: copy it over this
// file before running `firebase deploy --only firestore`, or the admin inbox stays shut
// for everyone, yourself included. Note that the live site's JavaScript still names the
// admin account in clear text — a browser has to recognise it to draw the UI — so this
// placeholder hides the address from a reader of the repo, not from a reader of the site.
```

And the rules themselves, which are the same text:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }

    // Contact page messages (top-level collection: /contactMessages/{id}).
    //  create: anyone, exactly these fields. "uid" is optional and, if present, must be the sender's own.
    //  read:   the developer (all messages) or a signed-in sender (only their own, matched by uid).
    //  update/delete: the developer, or the signed-in sender of that message (see below).
    match /contactMessages/{messageId} {
      allow create: if request.resource.data.keys()
                      .hasOnly(['name', 'email', 'message', 'createdAt', 'to', 'uid', 'read'])
        && request.resource.data.name is string
        && request.resource.data.name.size() > 0
        && request.resource.data.name.size() <= 80
        && request.resource.data.email is string
        && request.resource.data.email.size() > 0
        && request.resource.data.email.size() <= 120
        && request.resource.data.message is string
        && request.resource.data.message.size() > 0
        && request.resource.data.message.size() <= 2000
        && request.resource.data.createdAt is timestamp
        && request.resource.data.to == 'connect.darshanparmar@gmail.com'
        && (!('uid' in request.resource.data)
            || (request.auth != null && request.resource.data.uid == request.auth.uid))
        && (!('read' in request.resource.data) || request.resource.data.read == false);
      allow read: if request.auth != null && (
        request.auth.token.email == 'owner@example.com'
        || ('uid' in resource.data && resource.data.uid == request.auth.uid));
      // developer: only the "read" flag.  sender (signed in, own message): only the text, and it goes back to unread.
      allow update: if request.auth != null && (
        (request.auth.token.email == 'owner@example.com'
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['read']))
        || ('uid' in resource.data && resource.data.uid == request.auth.uid
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['message', 'editedAt', 'read'])
          && request.resource.data.message is string
          && request.resource.data.message.size() > 0
          && request.resource.data.message.size() <= 2000
          && request.resource.data.editedAt is timestamp
          && request.resource.data.read == false));
      // developer can delete anything; a signed-in sender can delete their own message.
      allow delete: if request.auth != null && (
        request.auth.token.email == 'owner@example.com'
        || ('uid' in resource.data && resource.data.uid == request.auth.uid));
    }

    // Developer's public profile photo (a small image). Anyone can read it; only the admin can write it.
    match /publicProfile/{docId} {
      allow read: if true;
      allow create, update: if request.auth != null
        && request.auth.token.email == 'owner@example.com'
        && request.resource.data.keys().hasOnly(['photo', 'updatedAt'])
        && request.resource.data.photo is string
        && request.resource.data.photo.size() < 100000;
      allow delete: if request.auth != null
        && request.auth.token.email == 'owner@example.com';
    }

    // Developer key (hash only). Readable and writable by the developer's account and nobody else.
    match /adminConfig/{docId} {
      allow read, write: if request.auth != null
        && request.auth.token.email == 'owner@example.com';
    }

    match /teams/{teamId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.ownerId;
      allow update: if request.auth != null && (
        request.auth.uid in resource.data.memberIds ||
        (
          request.auth.uid in request.resource.data.memberIds &&
          request.resource.data.diff(resource.data).affectedKeys().hasOnly(['memberIds', 'members'])
        )
      );

      match /goals/{goalId} {
        allow read, create, update: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
      }
      match /messages/{messageId} {
        allow read, create: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
        // a sender can delete their own message; the team owner can delete any (used by "Clear chat")
        allow delete: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds &&
          (resource.data.senderId == request.auth.uid ||
           get(/databases/$(database)/documents/teams/$(teamId)).data.ownerId == request.auth.uid);
      }
      // "Seen" receipts: each member writes only their own doc
      match /reads/{uid} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
        allow create, update, delete: if request.auth != null && request.auth.uid == uid &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
      }
      // "Typing…" indicator: each member writes only their own doc
      match /typing/{uid} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
        allow create, update, delete: if request.auth != null && request.auth.uid == uid &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
      }
      // ------------------------------------------------------------------
      // Shared docs.
      //
      // This block is what actually keeps a "view only" doc view only. The UI in
      // static/js/team.js and notepad/index.html is only the first half of the
      // lock; everything below is the half a hand-edited page cannot get past.
      //
      //   read  -> nobody may change anything except the person who shared the
      //            doc. No teammate, and not even the owner of the team.
      //   write -> every member may change title/body/updated* and nothing else.
      //
      // `permission` and `ownerId` are not in the member allow-list below, so a
      // teammate can never turn a locked doc into an editable one, and only the
      // owner can move between 'read' and 'write' at all.
      // ------------------------------------------------------------------
      match /docs/{docId} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
        allow create: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds &&
          request.resource.data.ownerId == request.auth.uid &&
          request.resource.data.permission in ['read', 'write'];
        allow update: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds && (
            // the person who shared the doc owns it: they may relock it, rename it,
            // anything — but the doc stays theirs and stays one of the two values
            (resource.data.ownerId == request.auth.uid &&
             request.resource.data.ownerId == resource.data.ownerId &&
             request.resource.data.permission in ['read', 'write']) ||
            // anybody else: only while the doc is unlocked, and only the text
            (resource.data.permission == 'write' &&
             request.resource.data.updatedBy == request.auth.uid &&
             request.resource.data.diff(resource.data).affectedKeys()
               .hasOnly(['title', 'body', 'updatedAt', 'updatedBy', 'updatedByName']))
          );
        // the doc owner or the team owner can delete (a delete, never an edit)
        allow delete: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds &&
          (resource.data.ownerId == request.auth.uid ||
           get(/databases/$(database)/documents/teams/$(teamId)).data.ownerId == request.auth.uid);
      }
      match /rewards/{rewardId} {
        allow read, create, update: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
      }
    }
  }
}
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }

    // Contact page messages (top-level collection: /contactMessages/{id}).
    //  create: anyone, exactly these fields. "uid" is optional and, if present, must be the sender's own.
    //  read:   the developer (all messages) or a signed-in sender (only their own, matched by uid).
    //  update/delete: the developer, or the signed-in sender of that message (see below).
    match /contactMessages/{messageId} {
      allow create: if request.resource.data.keys()
                      .hasOnly(['name', 'email', 'message', 'createdAt', 'to', 'uid', 'read'])
        && request.resource.data.name is string
        && request.resource.data.name.size() > 0
        && request.resource.data.name.size() <= 80
        && request.resource.data.email is string
        && request.resource.data.email.size() > 0
        && request.resource.data.email.size() <= 120
        && request.resource.data.message is string
        && request.resource.data.message.size() > 0
        && request.resource.data.message.size() <= 2000
        && request.resource.data.createdAt is timestamp
        && request.resource.data.to == 'connect.darshanparmar@gmail.com'
        && (!('uid' in request.resource.data)
            || (request.auth != null && request.resource.data.uid == request.auth.uid))
        && (!('read' in request.resource.data) || request.resource.data.read == false);
      allow read: if request.auth != null && (
        request.auth.token.email == 'owner@example.com'
        || ('uid' in resource.data && resource.data.uid == request.auth.uid));
      // developer: only the "read" flag.  sender (signed in, own message): only the text, and it goes back to unread.
      allow update: if request.auth != null && (
        (request.auth.token.email == 'owner@example.com'
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['read']))
        || ('uid' in resource.data && resource.data.uid == request.auth.uid
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['message', 'editedAt', 'read'])
          && request.resource.data.message is string
          && request.resource.data.message.size() > 0
          && request.resource.data.message.size() <= 2000
          && request.resource.data.editedAt is timestamp
          && request.resource.data.read == false));
      // developer can delete anything; a signed-in sender can delete their own message.
      allow delete: if request.auth != null && (
        request.auth.token.email == 'owner@example.com'
        || ('uid' in resource.data && resource.data.uid == request.auth.uid));
    }

    // Developer's public profile photo (a small image). Anyone can read it; only the admin can write it.
    match /publicProfile/{docId} {
      allow read: if true;
      allow create, update: if request.auth != null
        && request.auth.token.email == 'owner@example.com'
        && request.resource.data.keys().hasOnly(['photo', 'updatedAt'])
        && request.resource.data.photo is string
        && request.resource.data.photo.size() < 100000;
      allow delete: if request.auth != null
        && request.auth.token.email == 'owner@example.com';
    }

    // Developer key (hash only). Readable and writable by the developer's account and nobody else.
    match /adminConfig/{docId} {
      allow read, write: if request.auth != null
        && request.auth.token.email == 'owner@example.com';
    }

    match /teams/{teamId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.ownerId;
      allow update: if request.auth != null && (
        request.auth.uid in resource.data.memberIds ||
        (
          request.auth.uid in request.resource.data.memberIds &&
          request.resource.data.diff(resource.data).affectedKeys().hasOnly(['memberIds', 'members'])
        )
      );

      match /goals/{goalId} {
        allow read, create, update: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
      }
      match /messages/{messageId} {
        allow read, create: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
        // a sender can delete their own message; the team owner can delete any (used by "Clear chat")
        allow delete: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds &&
          (resource.data.senderId == request.auth.uid ||
           get(/databases/$(database)/documents/teams/$(teamId)).data.ownerId == request.auth.uid);
      }
      // "Seen" receipts: each member writes only their own doc
      match /reads/{uid} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
        allow create, update, delete: if request.auth != null && request.auth.uid == uid &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
      }
      // "Typing…" indicator: each member writes only their own doc
      match /typing/{uid} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
        allow create, update, delete: if request.auth != null && request.auth.uid == uid &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
      }
      // ------------------------------------------------------------------
      // Shared docs.
      //
      // This block is what actually keeps a "view only" doc view only. The UI in
      // static/js/team.js and notepad/index.html is only the first half of the
      // lock; everything below is the half a hand-edited page cannot get past.
      //
      //   read  -> nobody may change anything except the person who shared the
      //            doc. No teammate, and not even the owner of the team.
      //   write -> every member may change title/body/updated* and nothing else.
      //
      // `permission` and `ownerId` are not in the member allow-list below, so a
      // teammate can never turn a locked doc into an editable one, and only the
      // owner can move between 'read' and 'write' at all.
      // ------------------------------------------------------------------
      match /docs/{docId} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
        allow create: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds &&
          request.resource.data.ownerId == request.auth.uid &&
          request.resource.data.permission in ['read', 'write'];
        allow update: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds && (
            // the person who shared the doc owns it: they may relock it, rename it,
            // anything — but the doc stays theirs and stays one of the two values
            (resource.data.ownerId == request.auth.uid &&
             request.resource.data.ownerId == resource.data.ownerId &&
             request.resource.data.permission in ['read', 'write']) ||
            // anybody else: only while the doc is unlocked, and only the text
            (resource.data.permission == 'write' &&
             request.resource.data.updatedBy == request.auth.uid &&
             request.resource.data.diff(resource.data).affectedKeys()
               .hasOnly(['title', 'body', 'updatedAt', 'updatedBy', 'updatedByName']))
          );
        // the doc owner or the team owner can delete (a delete, never an edit)
        allow delete: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds &&
          (resource.data.ownerId == request.auth.uid ||
           get(/databases/$(database)/documents/teams/$(teamId)).data.ownerId == request.auth.uid);
      }
      match /rewards/{rewardId} {
        allow read, create, update: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
      }
    }
  }
}
```

`tests/docs.test.js` runs the real `static/js/doc-attrib.js` in a DOM and checks the access table, that attribution
survives editing / moving / retyping a line, that the sanitizer cannot be used to fake a name chip, that no doc surface
still ships editable, and that the rules in `firestore.rules` and the rules printed in this README have not drifted
apart. `tests/notepad.test.js` covers the Notepad & Docs surfaces the same way. Run them after any change to the
docs feature.

## Inspire Feed setup

The feed is a static file (`static/data/news.json`) refreshed every 6 hours by a GitHub Action.

1. In **Settings > Actions > General**, set **Workflow permissions** to **Read and write**.
2. Optional: add a free Gemini key from https://aistudio.google.com/apikey as a repository secret named `GEMINI_API_KEY` (**Settings > Secrets and variables > Actions**).
3. Open the **Actions** tab, choose **Update inspire feed** and click **Run workflow** once.

Stories come from public RSS feeds. Songs are 30-second previews from the iTunes Search API. Everything used is free.

## Captcha setup

Sign-in, sign-up and password reset are behind [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/),
the free captcha. Two keys, and they never sit in the same place:

| Key | Where it lives | Why |
| --- | --- | --- |
| **site key** | `TURNSTILE_SITE_KEY` in `static/js/auth.js` | public by design: the browser must render the widget |
| **secret key** | the Worker, as `TURNSTILE_SECRET` | never sent anywhere near a browser |

1. In the Cloudflare dashboard open **Turnstile**, add a widget in **Managed** mode, and list your hostnames
   (`<username>.github.io`, plus `localhost` if you test locally).
2. Put the site key in `static/js/auth.js`, then store the secret key on the Worker:

   ```bash
   cd ai-worker
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler deploy
   ```

The browser never decides whether a person is real. It hands the token to `POST /verify-turnstile` on the AI Worker,
and the Worker asks Cloudflare with the secret key. So editing the page, or calling Firebase directly from a script,
still gets nowhere. That route needs no Firebase token — it runs *before* sign-in — so it is guarded by the same
`ALLOWED_ORIGINS` list plus a per-IP cap, and it fails **closed**: if Cloudflare cannot be reached, nobody gets in.

Three details worth keeping if you edit this:

- A Turnstile token is good **once**. The widget is reset after every attempt, so a failed password cannot be replayed.
- The **Google** button skips the captcha on purpose: Google already checks for bots, and a second challenge in front
  of a one-click sign-in is a wall, not a door.
- **Guest mode** skips it too — no account is created, so there is nothing to burn.

This is the first half of bot defence only. For the second half, register the web app under **Firebase > App Check**
and enforce it on Authentication: otherwise a bot can skip your page entirely and call Firebase's API directly.
Turn on **email enumeration protection** in Authentication > Settings at the same time, so a wrong password cannot be
told apart from an address that has no account.

Cloudflare's test keys (`1x00000000000000000000AA` always passes, `2x00000000000000000000AB` always fails) are useful
on localhost. The site ships with the real key, so check it on the live site — a test key would let every bot through.

## Project structure

```
├── index.html            Dashboard
├── calendar/             Life calendar
├── notepad/              Notes and docs
├── team/                 Team goals, chat and rewards
├── contact/              Connect page — the form and the sender's own messages
├── admin/                Private inbox of every message (owner + key only)
├── ai/                   Infinite AI workspace
├── ai-worker/            Free Cloudflare Worker backend for the AI
├── functions/            Alternative Gemini backend (needs Blaze, not deployed)
├── static/
│   ├── css/              Styles
│   ├── js/               auth, dashboard, team, notes, doc attribution + access control,
│   │                     inspire feed, AI widget, developer key, contact + admin inbox
│   └── data/news.json    Inspire Feed data (auto-generated)
├── tests/                Docs ACL/attribution and Notepad tests (npm test)
├── firestore.rules       Firestore security rules — the half of the lock the browser cannot bypass
├── scripts/fetch-news.js Feed builder run by GitHub Actions
├── .github/workflows/    Scheduled feed update
├── robots.txt
├── sitemap.xml
└── .nojekyll
```

## Not in this repo

Kept out on purpose, so a fork cannot walk into the live project:

| Missing | Where it lives instead |
| --- | --- |
| the admin email address | in `firestore.rules.deploy` (gitignored) and, unavoidably, in the site's JavaScript |
| `HF_TOKEN` (AI provider) | `npx wrangler secret put HF_TOKEN` — a Worker secret |
| `TURNSTILE_SECRET` (captcha) | `npx wrangler secret put TURNSTILE_SECRET` — a Worker secret |
| `GEMINI_API_KEY` | a GitHub Actions secret, for the feed only |
| `ai-worker/wrangler.toml` | gitignored; `wrangler.example.toml` shows the shape |
| the deployed Worker URL | set in `ai/index.html` for your own deployment |

The Firebase Web API key is *not* on that list, and cannot be: it ships in `static/js/auth.js` to every visitor.
It identifies the project, it does not grant access — the rules decide that.

Two things cannot be hidden from a reader of this repo, and pretending otherwise would be the real mistake:

- **the admin address**, because `static/js/contact.js`, `static/js/admin.js` and `static/js/dev-key.js` ship it to
  the browser — the page has to know which signed-in account to offer the Developer box to. That is precisely why the
  inbox is protected by rules rather than by the address being a secret;
- **the Firebase Web API key**, which ships in `static/js/auth.js`. It identifies the project; the rules decide access.

## Licence

Do what you like with it. If you ship it, keep the part you like and drop the rest.
