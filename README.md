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
- **Accounts and cloud sync**: email login with Firebase, or use it as a guest without an account.
- **Light and dark mode**, responsive on desktop and mobile.

## Tech

Plain HTML, CSS and JavaScript. Firebase Authentication and Firestore for accounts and sync. GitHub Pages for hosting and GitHub Actions for the Inspire Feed. No build step.

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

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
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
      // Shared docs: every member can read. The doc owner can change anything; other members can only
      // change title/body/updated* and only while the owner has set permission to 'write' (edit access).
      // A 'read' doc is therefore locked for everyone but the owner, and permission/ownerId can never be
      // touched by anybody except the owner (they are not in the list below).
      match /docs/{docId} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
        allow create: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds &&
          request.resource.data.ownerId == request.auth.uid &&
          request.resource.data.permission in ['read', 'write'];
        allow update: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds && (
            (resource.data.ownerId == request.auth.uid &&
             request.resource.data.ownerId == resource.data.ownerId &&
             request.resource.data.permission in ['read', 'write']) ||
            (resource.data.permission == 'write' &&
             request.resource.data.updatedBy == request.auth.uid &&
             request.resource.data.diff(resource.data).affectedKeys()
               .hasOnly(['title', 'body', 'updatedAt', 'updatedBy', 'updatedByName']))
          );
        // the doc owner or the team owner can delete
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
apart. Run it after any change to the docs feature.

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
├── static/
│   ├── css/              Styles
│   ├── js/               auth, dashboard, team, notes, doc attribution + access control, inspire feed
│   └── data/news.json    Inspire Feed data (auto-generated)
├── tests/docs.test.js    Tests for the shared-doc lock and name attribution (npm test)
├── firestore.rules       Firestore security rules — the half of the lock the browser cannot bypass
├── scripts/fetch-news.js Feed builder run by GitHub Actions
├── .github/workflows/    Scheduled feed update
├── robots.txt
├── sitemap.xml
└── .nojekyll
```