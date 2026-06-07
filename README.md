# Codex Realtime Linux

An Electron MVP for a Linux-first, realtime voice Codex client.

This demo explores a voice-led interaction model for Codex: the user speaks, shares screen or image context, interrupts direction naturally, and the Codex execution layer works behind the scenes. The UI is intentionally desktop-like: workspace navigation on the left, nested agent conversations inside each workspace, a collaborative voice conversation in the center, and review, diff, browser context, and usage on the right.

This is an inspirational demo. It does not reverse engineer the closed Codex Mac app internals.

## Current Shape

- Electron desktop shell for Linux.
- Realtime API over WebRTC for live voice.
- `codex app-server` bridge for Codex agent conversations, events, approvals, apps, models, and auth state.
- Voice-first dock with no typed composer in the primary workflow.
- Collapsible workspace folders with nested agent conversations.
- Open agent conversations as separate center windows with independent content.
- Optional transcript view for voice conversations; hidden by default.
- Settings, Usage, and Account details as dedicated system screens.
- Screen sharing and image attachment as context surfaces.
- Spending and rate-limit panels with live data when the right API keys are present, and demo fallback data otherwise.
- Review pane with Codex-style diff cards for demo clarity.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` starts:

- API server on `http://127.0.0.1:3311`
- Vite renderer on `http://localhost:5173`
- Electron desktop shell loading the local renderer

For browser-only development:

```bash
npm run dev:browser
```

## API Keys

Live voice requires:

```bash
OPENAI_API_KEY=sk-...
```

For an API-key-only Codex demo:

```bash
OPENAI_API_KEY=sk-...
CODEX_USE_OPENAI_API_KEY=true
```

Use `CODEX_API_KEY` if Codex local execution should use a different key than Realtime voice:

```bash
CODEX_API_KEY=sk-...
```

Organization spending, project, and admin analytics require:

```bash
OPENAI_ADMIN_KEY=sk-admin-...
```

Without admin scope, the app keeps the demo usable with local workspace and spending fallback data.

## Architecture

- `server/index.mjs` is the local API bridge for Realtime session creation, Codex app-server RPC, workspace discovery, events, spending, and rate limits.
- `src/App.tsx` is the Electron renderer UI.
- `src/App.css` defines the compact dark desktop layout.
- `electron/main.cjs` creates the desktop window and loads the Vite renderer.

## Public Codex App Signals Mirrored

Based on public Codex app docs and product pages:

- Codex app is positioned as a command center for multiple agents running in parallel across projects.
- Agent conversations are grouped by workspace and can run in local, worktree, or cloud modes.
- Worktrees isolate parallel work and background automations from the foreground checkout.
- Review workflows include diff inspection, inline feedback, staging, commit, push, and PR flows.
- Automations create a triage/inbox loop for recurring work and agent conversation heartbeats.
- In-app browser supports local/public preview, page comments, and browser-use automation for scoped web QA.
- Computer Use and Appshots provide visual desktop/app context with explicit permissions.
- App-server is the public integration surface for custom clients: agent conversations, turns, approvals, history, auth, apps, models, and streamed events.

The demo’s differentiator is replacing the composer-first interaction model with a realtime voice director that supervises Codex execution.

## Next Milestones

- Persist real workspace and agent conversation state from Codex app-server into the sidebar.
- Stream Codex turn output into the center conversation instead of demo copy.
- Add real diff inspection from local changes and Codex agent conversation metadata.
- Wire screen/image context into the Realtime conversation payload.
- Add packaging for Linux AppImage or deb.

## Sources

- https://openai.com/index/introducing-the-codex-app/
- https://openai.com/codex/
- https://developers.openai.com/codex/app
- https://developers.openai.com/codex/app/features
- https://developers.openai.com/codex/app/worktrees
- https://developers.openai.com/codex/app/review
- https://developers.openai.com/codex/app/automations
- https://developers.openai.com/codex/app/browser
- https://developers.openai.com/codex/app/computer-use
- https://developers.openai.com/codex/appshots
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/api/docs/guides/realtime-webrtc
