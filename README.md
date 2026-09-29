# Infinite

**We deserve better.**

Infinite is a free goal and progress tracker that runs entirely in the browser. Track your year, month and week, set daily to yearly goals, plan on a life calendar, take notes, work with friends in teams, and get motivational stories and songs picked for your goals.

Live site: https://you-are-amazing.github.io/infinite/

## Features

- **Progress dashboard**: live progress for the year, quarter, month and week, with a quote of the day.
- **Goals**: daily, weekly, monthly and yearly goals with a habit tracker sheet.
- **Life Calendar**: see your whole year at a glance.
- **Notepad & Docs**: rich text notes with highlighting.
- **Team Goals**: create or join a team with an invite code, share goals, chat and cheer each other on.
- **Inspire Feed**: motivational news and song previews matched to your goals, updated automatically.
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
5. Create a **Firestore** database and use these rules:

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
      }
      match /rewards/{rewardId} {
        allow read, create, update: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.memberIds;
      }
    }
  }
}
```

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
│   ├── js/               auth, dashboard, team, notes, inspire feed
│   └── data/news.json    Inspire Feed data (auto-generated)
├── scripts/fetch-news.js Feed builder run by GitHub Actions
├── .github/workflows/    Scheduled feed update
├── robots.txt
├── sitemap.xml
└── .nojekyll
```