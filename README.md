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
- **Accounts and cloud sync**: email login with Firebase, or use it as a guest without an account.
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
5. Create a **Firestore** database and publish the rules. They live in **`firestore.rules`** in this repo — copy
   that whole file into **Firestore > Rules** and press Publish. The same text is reproduced below for reference;
   if the two ever disagree, `firestore.rules` is the one that is deployed.
6. **Before you publish:** replace `owner@example.com` in that file with your own account. It is a placeholder, and
   the admin inbox stays shut for everybody — you included — until you do.

> The address is a placeholder in this public copy on purpose. Nothing else here is a secret: the contact address is
> printed on the public Connect page, and the Firebase Web API key ships in every page that uses Firebase. Real
> secrets (the AI provider token, the Gemini key) are never committed — see [Not in this repo](#not-in-this-repo).

The public copy of `firestore.rules` opens with this note:

```
// Firestore security rules for Infinite.
//
// PUBLIC COPY: owner@example.com below is a placeholder for your own account — the one
// allowed to read every message and to hold the developer key. Replace it before running
// `firebase deploy --only firestore`, or the admin inbox stays shut for everyone, yourself
// included. The contact address is not a secret: it is printed on the public Connect page.
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

    // Developer key (a salted PBKDF2 hash only, never the key itself).
    // Readable and writable by the developer account and nobody else.
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

## Security model

The recurring idea in this project: **hiding something in the page is not the same as protecting it.** Every lock
has a server-side half in `firestore.rules`, and the page is only the polite half.

**The private inbox.** `/admin/` is `noindex`, it starts locked, and it is opened by the Developer box on the
Connect page. Three layers, weakest first:

- the page: a non-owner is refused before anything is fetched, and even a hand-edited page that skips the dialog
  still gets nothing back;
- the key: the developer sets a key of at least 6 characters, and only a **salted PBKDF2-SHA256 hash**
  (150,000 iterations) is ever stored, in `adminConfig/devKey`. Five wrong tries lock the box for 30 seconds.
  The unlock is a flag in `sessionStorage` keyed to the account id, so a copied flag does nothing for anyone else;
- the rules: only the owner account may read every message, mark one read, or delete one. This is the layer that
  actually holds. A key checked in the browser is a speed bump; a key checked by a server would need a Cloud
  Function.

**Who owns a message.** A signed-in sender can read, edit and delete **their own** message and nobody else's,
matched on the `uid` stamped at write time; a signed-in sender can only ever touch `message`, `editedAt` and
`read` on it, never the name, address or timestamps around it, and an edit always puts the message back in the
unread pile. A signed-out visitor can still file a message, but gets no `uid`, so nobody can query their copy back
out of Firestore — their sent list lives in their own browser, and only the owner can read the stored message.

**Nobody can stuff the collection.** Creation is `hasOnly([...])` with a type, a length and a `to` check on every
field, so a script can add a well-formed message and nothing else. For the same reason an update may only touch the
keys listed for it: the admin's update allow-list is `['read']`, a sender's is `['message', 'editedAt', 'read']`.

The shared-doc lock follows exactly the same rule — see below.

## Connect and the private inbox

- Visitors fill in a name, an email and a message on `/contact/`. The message is written to Firestore **and** sent
  by email through FormSubmit, and the two paths are tracked separately, so one failing never loses the other.
- Every sender gets a **Your sent messages** list under the form: a signed-in visitor reads it back from Firestore,
  a guest reads it from their own browser storage. Each row expands to show what they wrote, and can be edited or
  deleted.
- The owner gets `/admin/`: every message newest first, All and Unread tabs, search over name, address and text,
  opening a message marks it read, and **Reply by email** opens the visitor's own mail client with the original
  quoted. There is deliberately no on-site reply box anywhere — replies leave from your mail app, so there is
  nothing here to keep, moderate or leak.
- The sidebar's **Admin Inbox** item only appears for the owner, and clicking it opens the key popup instead of
  navigating, so the link is never a way around the key.
- The site notification bell carries **both** sources in one panel: team chat messages and Connect messages, with
  a red count on the bell, on the Team Goals item, and on the Admin Inbox item. A Connect message is "unread" while
  its server flag says so, so opening the inbox on any device clears the badge everywhere. **Mark all read** writes
  that flag, and a Connect item leads to the Developer box rather than to `/admin/`, which cannot help anyone who
  cannot get through it.

## Infinite AI

An assistant that knows your data and can only *ask* to change it.

- It receives a read-only snapshot: your goals (up to 60), notes (up to 25) and saved links (up to 25), plus today's
  date. Your browser sends it; no service account ever holds your data.
- It answers in a small JSON envelope, `{"reply": "...markdown...", "proposed": [...]}`, and every proposal is
  re-validated on the server: an unknown tool name, a goal id that does not exist, a non-YouTube URL or an
  oversized field is dropped before it reaches the screen.
- A proposal never writes anything. It appears as a card with **Add** and **Skip**; only Add writes to
  `localStorage` in the app's own formats and fires the normal sync event, so an AI-added goal behaves exactly like
  a typed one.
- The prompt tells it what it cannot do, and the code backs that up: no internet search, no opening links, files or
  videos, no inventing data, and never claiming something was saved before you confirm.
- Free tier, on purpose: a Cloudflare Worker in front of Hugging Face's free router, with model fallback, a 60s
  upstream timeout, one automatic retry, and **40 messages per user per UTC day**. Answers are capped at 900 tokens,
  so expect short lists rather than essays, and expect the small free model to be good at planning and weak at
  anything needing current facts. `ai-worker/README.md` has the setup and the honest limits.

Two backends are in the repo: `ai-worker/` is the free one that is deployed, and `functions/index.js` is the older
Firebase callable (Gemini, with server-side tools) which needs the Blaze plan and is **not** deployed.

## Shared docs (Notepad & Docs + Team page)

- Sign in, open **Notepad & Docs**, write a note and press **Share with team**.
- Pick a team (or join with an invite code / create one right in the dialog) and choose what teammates can do:
  **Edit (read & write)** or **View only (read)**. The doc owner can change this later from the banner above the doc.
- The doc is copied into `teams/{teamId}/docs`, and a doc card is posted in the team chat. Tapping the card opens the
  doc in the team page's **Docs** tab. Shared docs also show up under **TEAM DOCS** in the Notepad sidebar.
- Sharing the same note again updates the existing team copy instead of creating a duplicate.
- Teammates with edit access are autosaved live; view-only members see a locked doc. Only the doc owner or the team
  owner can delete a shared doc.
- **Publish the updated Firestore rules above** (they now include the `/docs` block), otherwise sharing shows
  "permission denied".

### Read-only means read-only

When a doc is shared as **view only**, it is locked for everybody except the person who shared it:

- the title, the body and the formatting bar are switched off (`contentEditable=false`, toolbar hidden and
  disabled, `beforeinput` / `paste` / `drop` refused), so nothing can be typed into it;
- the access switch is rendered **only** for the owner and is `disabled` for everyone else, so no teammate — not
  even the team owner — can flip a locked doc back to "can edit"; the owner is asked to confirm before a doc is
  opened up;
- the rule is checked again in every write path straight from the live snapshot, so if the owner locks the doc while
  someone is typing, that person's pending save is dropped and the screen is reloaded with the stored text;
- and the `/docs` rules above repeat all of it on the server, so a hand-edited page still cannot write to a locked doc.

There is one decision function for all of that, `InfiniteDocs.acl()` in `static/js/doc-attrib.js`, and **both** the Team
page and the Notepad call it. Neither page keeps its own copy, so the two can never drift apart into disagreeing about
who may write. It fails closed at every step:

| Situation | Who may type | Who may change read ↔ write |
| --- | --- | --- |
| `permission: 'read'` (the person who shared it) | the sender | the sender |
| `permission: 'read'` (any other teammate) | nobody | nobody |
| `permission: 'read'` (the team owner, who is not the sender) | nobody | nobody |
| `permission: 'write'` (any team member) | the team | only the sender |
| permission missing or an unknown value | nobody but the sender | nobody but the sender |
| signed out, doc not loaded, or not a team member | nobody | nobody |

Every doc surface also **starts** read only in the HTML and is only made editable once a snapshot has proved the viewer
may write, so a doc that is still loading — or a viewer who is not allowed in — is never briefly editable.

### Who wrote which part

`static/js/doc-attrib.js` stamps authorship inside the doc body — nothing new is stored in Firestore:

- on every save the body is split into blocks and compared with the version that is currently stored; new and
  changed blocks get `data-by` (uid), `data-by-name` (shown as a chip) and `data-c` (a colour per person), while
  blocks that still match keep the author they already had;
- matching is done on the text of a line, so reformatting or moving a line does not steal somebody's authorship, and
  a line that is deleted and typed again comes back with its original name;
- the doc owner's own lines are marked `data-orig` and stay plain, so a teammate's addition is what stands out —
  the name is rendered from CSS, never typed into the editable text, so it cannot be faked by writing it in the doc;
- the sanitizer in the same file is what every doc is passed through, and it only lets those stamps (plus a small
  tag whitelist) through, so a teammate cannot smuggle markup or a fake name into someone else's doc;
- the meta line under a doc and the rows in both doc lists show who has added something ("added by Ravi, Mike").

Attribution is deliberately best-effort, like a light version of Google Docs: whoever saves last is the one whose
browser sees which lines are new, so two people typing the exact same second can blur a brand-new line. Docs shared
before this existed have no stamps yet; when somebody edits one, the lines that were already there are credited to
the person who shared the doc (not to whoever happened to save next), and only the newly written lines get a name.

### Tests

The two promises above — *a view only doc really is view only* and *a teammate's new lines really carry their name* —
are covered by an automated suite:

```bash
npm install   # once, only needed for jsdom
npm test
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
| `owner@example.com`, your real admin address | only in the rules you publish to your own Firebase project |
| `HF_TOKEN` (AI provider) | `npx wrangler secret put HF_TOKEN` — a Worker secret |
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
