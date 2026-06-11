# MVP Hardening Spec

Audit date: 2026-06-11

This document is the operating spec for taking Codex Realtime Linux from prototype to MVP-ready desktop app. It is grounded in the current repository state, not a future product wish list.

## Updated Goal

Make Codex Realtime Linux MVP-ready as a standalone Linux desktop app that can be launched from the app menu, controlled by realtime voice, route Codex work only to the selected workspace by default, create and preview generated HTML artifacts without hardcoded viewer behavior, preserve local workspace/thread state reliably, and fail clearly across voice, Codex, preview, weather, USB, Arduino, and Settings flows.

MVP-ready does not mean feature-complete with the public Codex app. It means the implemented scope is reliable, bounded, documented, recoverable, and manually verified on the target Linux desktop.

## Current Guarantees

- The desktop launcher installs an app-menu entry, starts Electron in production mode, rebuilds stale renderer output, writes user-only logs, and rejects malformed XDG path overrides.
- The Electron shell uses context isolation, disabled Node integration, sandboxed renderer settings, trusted IPC checks, local-origin navigation guards, and permission checks limited to the app frame.
- The local API validates JSON bodies, rejects untrusted browser origins, bounds upstream requests, and returns normalized JSON errors for API failures.
- Realtime voice uses bounded runtime instructions, transcript normalization, cancellable connection setup, stale tool-call dropping, duplicate tool-call suppression, and bounded function outputs.
- Codex task routing requires an explicit existing workspace, rejects this app source tree by default, preserves app-source guardrails when app-source tasks are explicitly allowed, and creates generated artifact plans server-side instead of embedding fixed paths in Realtime prompts.
- Generated HTML previews are workspace-scoped, temporary, closeable, hidden on system screens/workspace navigation, remounted on artifact timestamp changes, and served through a sandboxed iframe with strict preview CSP.
- Local state and Settings secrets are persisted outside the repo with bounded normalization, user-only permissions, atomic writes, backup recovery, and strict row-key mutation for duplicate conversation IDs.
- Weather, USB, and Arduino integrations validate inputs, bound diagnostics, avoid fake data, and surface hardware ambiguity instead of guessing.
- Automated validation currently covers API routing, persistence, preview policy, app-source guards, renderer invariants, Arduino/USB/weather modules, desktop install behavior, linting, and production build correctness.
- Browser-driven renderer smoke coverage now exercises the voice surface, Settings/Usage/Profile navigation, empty workspace state, transcript toggle, and generated preview open/close behavior against a real Chromium instance.
- Degraded-mode smoke coverage now exercises first-run empty state, corrupted primary state recovery from backup, malformed saved secrets, missing Realtime key handling, missing Codex CLI behavior, unexpected Codex app-server payload handling, unauthenticated Codex account state, and slow Codex app-server timeout behavior.
- Production dependency audit currently reports no vulnerabilities with `npm audit --omit=dev`.

## MVP Acceptance Criteria

1. Standalone launch: after `npm run install:desktop`, the app launches from the Linux app menu without a terminal, uses the built renderer, starts the local API server, and reports a healthy `/api/status`.
2. No hardcoded content path: asking Realtime/Codex to create an HTML presentation writes it under the selected workspace's `public/agent-files/` folder, never root `index.html`, bundled public demo routes, or this app source tree unless explicitly opted in for app-source work.
3. Temporary browser view: the in-app browser preview appears only for a newly completed foreground artifact, can be closed, does not reopen old artifacts on startup/navigation/polling, and expires after the idle viewing window.
4. Subtle agent activity: Codex work indicators stay local to the relevant work surface and never overtake the full window or follow the user into unrelated workspaces/system screens.
5. Voice fundamentals: voice can start, cancel during connection, go live, mute/unmute, stop, record transcript lines, save transcript to the bound conversation, and ignore in-flight tool completions after the session ends.
6. Workspace safety: Codex tasks, Codex history, generated artifacts, hidden thread deletes, and local conversations remain scoped to the selected workspace and cannot delete or mutate unrelated workspace rows.
7. App-source safety: app-source paths remain protected by default, symlinked app paths are treated as protected, and opt-in app-source tasks still carry protected-path prompt guardrails.
8. Hardware clarity: USB detection may acknowledge a connected Arduino-like device, but uploads must compile first, require a supported action, choose only detected supported ports, avoid flashing ambiguous boards, and display upload failure state clearly.
9. Settings and secrets: OpenAI keys can be saved/removed locally without exposing absolute secret paths in responses, and invalid or oversized saved secret files are ignored safely.
10. Usage and weather honesty: Usage and weather screens show live normalized data or explicit empty/error states; they must not fabricate placeholders as real data.
11. Security envelope: untrusted origins, malformed JSON, oversized payloads, hidden preview files, symlink escapes, top-level preview navigation, and unsupported preview file types are rejected.
12. Verification discipline: `npm run lint`, `npm run build`, `npm test`, dependency audit, and the manual live verification checklist pass before tagging an MVP build.

## Hardening Backlog

### P0 Before MVP Tag

- Maintain and expand browser-driven smoke coverage for the renderer using Playwright or equivalent:
  - app starts to the voice surface
  - Settings/Usage/Profile navigation does not collapse sidebar entries
  - workspace with no threads stays on the voice surface
  - generated preview open/close behavior is visible and closeable
  - transcript panel toggles without layout overlap
- Maintain the desktop release smoke script that runs installation checks and verifies:
  - desktop entry exists
  - launcher path is executable
  - app server becomes healthy
  - status appRoot matches the repo
  - startup logs are created under the expected state directory
- Manually run and record the Live Verification Checklist on the target Linux desktop, including microphone, speaker, screen capture, app-menu launch, and physical Arduino upload.
- Maintain degraded-mode smoke coverage for first-run behavior, corrupted state/secrets recovery, missing Realtime credentials, missing Codex CLI behavior, unexpected Codex app-server responses, slow Codex app-server responses, and unauthenticated Codex account states.
- Confirm Realtime voice failure modes with missing key, invalid key, denied microphone permission, and network timeout.

### P1 Immediately After MVP

- Stream Codex turn output into the selected conversation instead of relying only on activity/event polling.
- Add approval handling UI before recommending `CODEX_APPROVAL_POLICY=on-request` for complex voice-routed work.
- Add a structured release note template that records automated checks, manual checks, dependency audit, known limitations, and commit SHA.
- Add dependency update cadence and a scheduled audit check.
- Split the large renderer into smaller modules once the behavior contract is stable enough to avoid accidental UI regressions.
- Add packaged distribution target evaluation for AppImage or deb.

### P2 Product Growth

- Add richer browser QA controls only after preview lifecycle remains stable.
- Consider continuous visual context only when there is a clear product need beyond single-frame image/screen summaries.
- Add worktree/cloud execution modes only when workspace isolation and approval handling are mature.

## Non-Goals For MVP

- Full parity with the public Codex Mac app.
- Cloud execution, worktree management, browser-use automation, page comments, or Appshots.
- Continuous video understanding.
- Arbitrary Arduino sketch generation without explicit supported action/custom sketch validation.
- Running Codex tasks inside this app source tree by default.

## Audit Findings To Track

- The automated test suite is strong for server and source-policy invariants, but it is not a substitute for real renderer interaction testing.
- Hardware and OS permission behavior cannot be proven by the current automated tests.
- The renderer is large enough that targeted UI smoke tests are now more valuable than adding more regex-only policy assertions.
- Codex app-server behavior is an external dependency; MVP readiness requires graceful degraded states when it is missing, slow, unauthenticated, or returns unexpected payloads.
- Realtime model/tool behavior is probabilistic; schemas and guards are in place, but physical workflows still need manual validation.
- The current scope is intentionally local-first. Any future remote or cloud capability needs a separate trust-boundary review before implementation.

## Release Gates

Every MVP candidate must record:

- Commit SHA and branch.
- `npm run lint` result.
- `npm run build` result.
- `npm test` result and test count.
- `npm run smoke:degraded` result.
- `npm run smoke:desktop` result.
- `npm run smoke:renderer` result.
- `npm audit --omit=dev` result.
- Desktop app restart/status result from `systemctl --user restart codex-realtime-linux-app.service` and `/api/status`.
- Manual Live Verification Checklist result.
- Known limitations accepted for that build.
