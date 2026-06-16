# Security Best Practices Report

Generated: 2026-06-16

## Executive Summary

The repository is aligned with `origin/main` at commit `f49e137253228ca2e9b7ee8bbc934d1dd0425bfa`, but the working tree contains local uncommitted changes in the app hardening path. The current working tree has a strong security posture for an Electron/localhost prototype: the API binds to loopback, Electron uses context isolation and a sandboxed renderer, generated previews are served through realpath-checked workspace routes with opaque workspace tokens, preview iframes omit `allow-same-origin`, request bodies are bounded, secrets/state are persisted outside the repo with restrictive permissions, and automated tests cover many hardening cases.

I found no critical application-code vulnerability. The main review findings were a high-impact development-mode exposure through Vite's `0.0.0.0` proxy, one known high-severity dev dependency advisory, and several local trust-boundary risks inherent to exposing Codex, OpenAI token minting, and Arduino upload actions over a localhost API. These findings have been remediated in the current working tree.

## Remediation Status

- SBP-001: Fixed. Default Vite dev scripts now bind to `127.0.0.1`; explicit LAN exposure moved to `npm run dev:lan`.
- SBP-002: Fixed. `form-data` is overridden to `^4.0.6`, and `npm audit --audit-level=high` reports zero vulnerabilities.
- SBP-003: Fixed. Privileged `/api/*` routes require `X-Codex-Local-Api-Token` when `CODEX_LOCAL_API_TOKEN` or Electron's desktop server token is configured; `/api/status` remains open for health checks.
- SBP-004: Fixed. USB scans moved from `GET /api/usb/events?scan=true` to `POST /api/usb/events/scan`.
- SBP-005: Fixed. Workspace artifact preview tokens are opaque per-process UUIDs mapped server-side instead of base64url-encoded absolute paths.

## High Severity

### SBP-001: Development Vite server can expose the localhost API proxy on the LAN

Rule ID: EXPRESS-CORS-001 / EXPRESS-INPUT-001 / REACT-SUPPLY-001

Severity: High for development on untrusted networks; Low for packaged Electron-only use.

Location: `package.json:8`, `package.json:9`, `package.json:10`, `vite.config.ts:15`

Original evidence:

```json
"dev": "... \"vite --host 0.0.0.0\" ..."
"dev:browser": "... \"vite --host 0.0.0.0\""
"dev:ui": "vite --host 0.0.0.0"
```

```ts
server: {
  proxy: {
    '/api': apiTarget,
    '/workspace-artifacts': apiTarget,
  },
},
```

Impact: The API server itself listens on `127.0.0.1`, but the Vite dev server listens on all interfaces and proxies `/api` to `127.0.0.1:3311`. A host on the same LAN could potentially reach the dev server and use it as a proxy to local API routes. Browser-origin checks reduce some browser-based POST risk, but non-browser clients or requests without an `Origin` header are not blocked by that control. The exposed API includes sensitive local actions such as OpenAI Realtime token minting, Codex task execution in selected workspaces, state mutation, and Arduino upload.

Fix applied: `npm run dev`, `npm run dev:browser`, and `npm run dev:ui` bind Vite to `127.0.0.1`. A separate `npm run dev:lan` script preserves intentional LAN testing. Privileged API routes also support a local API token header as defense-in-depth.

Mitigation: Run development only on trusted networks and avoid `CODEX_APPROVAL_POLICY=never` while the dev server is exposed.

False positive notes: The packaged Electron path does not use Vite's LAN listener. This finding is specifically about `npm run dev`, `npm run dev:browser`, and `npm run dev:ui`.

### SBP-002: Known high-severity dev dependency advisory in `form-data`

Rule ID: EXPRESS-DEPS-001 / REACT-SUPPLY-001

Severity: High advisory; practical app impact appears limited because it is dev-only and `npm audit --omit=dev` is clean.

Location: `package-lock.json:1510`, `package-lock.json:2435`

Original evidence:

```json
"form-data": "^4.0.5"
```

```json
"node_modules/form-data": {
  "version": "4.0.5",
  "dev": true
}
```

`npm audit --json` reports GHSA-hmw2-7cc7-3qxx: CRLF injection in `form-data` before `4.0.6`. The dependency path is `wait-on@9.0.10 -> axios@1.17.0 -> form-data@4.0.5`.

Impact: This does not affect production dependencies, but it still affects developer/CI installs and any dev tooling path that creates multipart form requests with attacker-influenced field names or filenames.

Fix applied: `package.json` adds an `overrides` entry for `form-data: ^4.0.6`, and the lockfile resolves the dependency to `4.0.6`.

Mitigation: Treat the advisory as lower urgency than runtime API exposure, but patch it before release/CI hardening.

False positive notes: `npm audit --omit=dev --json` reported zero production vulnerabilities.

## Medium Severity

### SBP-003: Sensitive local API routes rely on loopback and `Origin` filtering, not request authentication

Rule ID: EXPRESS-CORS-001 / EXPRESS-CSRF-001

Severity: Medium.

Location: `server/index.mjs:314`, `server/index.mjs:320`, `server/index.mjs:345`, `server/index.mjs:2286`, `server/index.mjs:2362`, `server/index.mjs:2506`

Evidence:

```js
const origin = req.get('origin')
if (origin && !ALLOWED_API_ORIGINS.has(origin)) {
  res.status(403).json({ error: 'Request origin is not allowed.', code: 'origin_not_allowed' })
  return
}
```

Sensitive routes include:

```js
app.post('/api/realtime/token', ...)
app.post('/api/arduino/upload', ...)
app.post('/api/codex/task', ...)
```

Impact: For a single-user local desktop app, loopback-plus-Origin may be an acceptable baseline, but it is not an authentication boundary. Same-user local processes, non-browser tools, exposed dev proxies, and requests without an `Origin` header can still target the API. The most important consequences are API-cost exposure through token creation, local workspace modification through Codex, and firmware upload to detected boards.

Fix applied: Electron shares a per-launch local API token with the trusted preload/renderer path. The renderer adds `X-Codex-Local-Api-Token` to API requests, and the API rejects privileged routes with `local_api_token_required` when a token is configured.

Mitigation: Keep the API bound to `127.0.0.1`, avoid exposing Vite/preview proxies, and keep dangerous modes such as `CODEX_APPROVAL_POLICY=never` limited to trusted workspaces.

False positive notes: Same-user local malware can usually read the user's files anyway. The concern here is reducing accidental LAN/browser/proxy exposure and drive-by local API use.

### SBP-004: GET routes can perform expensive or stateful local work and are reachable without an `Origin` header

Rule ID: EXPRESS-CSRF-001 / EXPRESS-DOS-001

Severity: Medium.

Location: `server/index.mjs:320`, `server/index.mjs:2332`, `server/index.mjs:2334`, `server/index.mjs:2416`, `server/index.mjs:2442`, `server/index.mjs:2472`

Evidence:

```js
const scan = req.query.scan === 'true'
if (scan) await usbMonitor.scanSerialDevices()
```

Other GET routes initialize or query local integrations, including Codex account/model/thread routes. The guard blocks only disallowed non-empty `Origin` values; requests without `Origin` continue.

Impact: A malicious web page may not be able to read CORS-protected JSON, but it can still trigger GETs as navigations/subresources. Through the Vite proxy or direct local requests, these routes can cause process startup, Codex bridge initialization, hardware scans, and repeated local work.

Fix applied: `/api/usb/events?scan=true` now returns `405 usb_scan_requires_post`, and manual scans use `POST /api/usb/events/scan`, protected by the same local API guard when a token is configured.

Mitigation: Keep GET routes idempotent and cheap. Stateful manual USB scanning now uses POST.

False positive notes: I did not prove remote data exfiltration through these GETs; this is a local action/DoS and boundary-hardening issue.

## Low Severity

### SBP-005: Workspace artifact tokens expose absolute local workspace paths when decoded

Rule ID: REACT-FILE-001 / JS-STORAGE-001 privacy hardening

Severity: Low.

Location: `server/index.mjs:498`, `server/index.mjs:502`, `server/index.mjs:752`, `server/index.mjs:758`

Evidence:

```js
function workspaceToken(workspacePath) {
  return Buffer.from(path.resolve(workspacePath), 'utf8').toString('base64url')
}
```

```js
workspacePath: artifactPlan.workspacePath,
url: artifactPlan.url,
```

Impact: The token is not opaque; it is a base64url-encoded absolute local path. Any generated preview can see its own URL and recover the local workspace path. The same response object also includes the workspace path. The current iframe CSP and sandbox prevent straightforward network exfiltration from previews, but the path can still be displayed, logged, copied, or included in generated content.

Fix applied: Workspace preview tokens are generated with `randomUUID()` and stored in server-side maps. The renderer validates only the opaque token route shape and encoded preview path; it no longer computes a base64url token from the local workspace path.

Mitigation: Treat preview URLs and artifacts as local/private. Continue using `connect-src 'none'` and `sandbox="allow-scripts"` without `allow-same-origin`.

False positive notes: This is a privacy-hardening issue rather than direct privilege escalation, and Codex-generated content may already have workspace context.

## Positive Findings

- The API binds to `127.0.0.1`, not all interfaces: `server/index.mjs:3100`.
- The API disables `x-powered-by`, enforces JSON body limits, and rejects non-JSON mutation bodies: `server/index.mjs:314`, `server/index.mjs:353`.
- App shell CSP is strict for scripts and blocks framing: `server/index.mjs:579`.
- Generated preview routes use path segment validation plus `realpath` containment checks before `sendFile`: `server/index.mjs:2929`.
- Generated preview iframes are sandboxed without `allow-same-origin`: `src/App.tsx:4425`.
- Electron uses `contextIsolation`, disables Node integration, enables renderer sandboxing, validates IPC sender frames, and restricts external navigation: `electron/main.cjs:303`, `electron/main.cjs:434`, `electron/main.cjs:443`.
- Arduino command execution uses `spawn` with argument arrays and validates ports/FQBNs/sketch size before invoking `arduino-cli`: `server/arduino.mjs:118`, `server/arduino.mjs:345`, `server/arduino.mjs:592`.
- OpenAI/Weather upstream responses and timeouts are bounded: `server/index.mjs:638`, `server/weather.mjs:130`.

## Verification Performed

- `git fetch --prune origin`: local `HEAD` and `origin/main` both resolve to `f49e137253228ca2e9b7ee8bbc934d1dd0425bfa`.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `npm run lint`: passed.
- `npm test`: passed, 126 tests.
- `npm run build`: passed.
