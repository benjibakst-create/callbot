# Dial-In — Cold Call Trainer

A voice-based cold calling practice app. You talk out loud to an AI "prospect"
persona, they react and can hang up or agree to a meeting, and afterward
you get a scorecard.

## How it's structured

```
cold-call-trainer/
├── public/
│   └── index.html        ← the whole frontend (UI, speech, logic)
├── api/
│   ├── prospect-turn.js  ← backend function: runs one call turn
│   └── feedback.js       ← backend function: scores the finished call
├── package.json
└── README.md
```

The frontend never talks to Anthropic directly — it calls your own
`/api/prospect-turn` and `/api/feedback` endpoints, which hold your API key
server-side. This is what makes it safe to make public: nobody can see or
steal your key from the browser.

## Deploy it (free, ~10 minutes)

### 1. Get an Anthropic API key
Go to **console.anthropic.com** → **API Keys** → **Create Key**. Copy it
somewhere safe — you'll paste it into Vercel in step 4.

You'll also want to set a spending limit: in the console, go to
**Settings → Billing → Usage limits** and set a monthly cap. This is a
public app — a limit protects you from a surprise bill if the link gets
around more than expected.

### 2. Put this folder on GitHub
- Create a free account at **github.com** if you don't have one.
- Create a new repository (e.g. `cold-call-trainer`).
- Upload this entire folder to it — either drag-and-drop the files in the
  GitHub web UI ("Add file → Upload files"), or if you're comfortable with
  git:
  ```
  git init
  git add .
  git commit -m "Initial commit"
  git branch -M main
  git remote add origin https://github.com/YOUR-USERNAME/cold-call-trainer.git
  git push -u origin main
  ```

### 3. Import it into Vercel
- Go to **vercel.com** and sign up (use "Continue with GitHub" — it's the
  easiest path).
- Click **Add New → Project**, and select your `cold-call-trainer` repo.
- Leave all build settings as default — Vercel auto-detects this project
  structure (static `public/` folder + `api/` serverless functions).

### 4. Add your API key as an environment variable
Before clicking Deploy (or right after, in Project Settings):
- Go to **Settings → Environment Variables**.
- Add `ANTHROPIC_API_KEY` = *the key you copied in step 1*.
- Optionally add `APP_PASSWORD` = *any word or phrase you choose* — this
  becomes the access code people need to type in before using the app.
  If you skip this, the app is open to anyone with the link.
- Click **Deploy**.

### 5. You're live
Vercel gives you a URL like `cold-call-trainer.vercel.app`. That's a real,
public website — share it with anyone. If you set `APP_PASSWORD`, tell
them the code separately.

## Updating it later
Any time you want to change something, edit the files and push to GitHub
(`git add . && git commit -m "..." && git push`) — Vercel automatically
redeploys.

## Notes & known limitations
- **Browser support for speech recognition** is best in Chrome. Safari and
  Firefox have weaker support; the app falls back to a text-input field so
  it still works there, just without live transcription.
- **Text-to-speech voice** uses the browser's built-in voices, which sound
  fine but robotic. Swapping in a service like ElevenLabs would be the
  single biggest upgrade to realism, at the cost of added complexity and
  a second API key.
- **No accounts or saved history** — every session is stateless. Progress
  isn't tracked across calls. Adding that would need a real database.
- **No per-user rate limiting** — the access code stops randoms from
  finding it, but doesn't stop one person from hammering it with requests.
  The Anthropic usage cap from step 1 is your safety net here.
