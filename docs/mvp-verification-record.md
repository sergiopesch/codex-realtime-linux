# MVP Verification Record

Date: 2026-06-11

Status: automated release gates passed; MVP is not complete until the manual live checklist below is run and recorded on the target desktop.
Machine-observable desktop evidence should be captured with `npm run verify:live`, which writes `docs/mvp-live-probe-result.md`.
Manual checklist evidence should be captured with `npm run verify:manual`, which writes `docs/mvp-live-checklist-result.md`.
Final readiness should be checked with `npm run verify:mvp`, which writes `docs/mvp-readiness-report.md` and fails until the manual checklist is complete.

## Automated Evidence

- Branch: `main`
- Previous pushed commit before this verification update: `df173af`
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm test`: passed, 123 tests.
- `npm run smoke:degraded`: passed.
- `npm run smoke:desktop`: passed with user service restart.
- `npm run smoke:renderer`: passed.
- `npm audit --omit=dev`: passed, 0 vulnerabilities.
- Desktop API status: passed at `http://127.0.0.1:3311/api/status`; `appRoot` returned `/home/sergiopesch/codex-realtime-linux`.

## Live Desktop Evidence

- Desktop service: `codex-realtime-linux-app.service` was active under the user systemd session and running the app launcher through the `dialout` group handoff.
- Desktop launcher: `~/.local/share/applications/codex-realtime-linux.desktop` exists with `Name=Codex`, `Terminal=false`, and `Exec=/home/sergiopesch/codex-realtime-linux/scripts/launch-desktop.sh`.
- Desktop logs: `desktop-launch.log` and `api-server.log` exist under `~/.local/state/codex-realtime-linux/` with `0600` permissions.
- API health: `/api/status` returned `realtime: true`, `openAiKeySource: settings`, `appRoot: /home/sergiopesch/codex-realtime-linux`, `usb.active: true`, and Arduino CLI availability.
- Realtime token: a bodyless `POST /api/realtime/token` returned HTTP 200; token contents were not recorded.
- Local media devices: PipeWire reported speaker output, multiple microphone inputs, and an integrated camera. This proves device enumeration only, not user permission acceptance inside Electron.
- USB and Arduino: `POST /api/usb/events/scan` returned no connected devices; `/api/arduino/status` reported no boards and no serial ports. A safe upload request returned `arduino_port_not_found`, so physical upload success could not be verified without connecting the board.
- Weather: live London lookup reached the app route but the upstream weather service did not return live data. The app surfaced an explicit bounded weather error instead of fabricated data.

## Degraded Coverage Confirmed

- First-run empty state with no state/secrets files.
- Corrupted primary state recovery from backup.
- Malformed saved secrets ignored safely.
- Missing Realtime key returns bounded JSON.
- Invalid upstream Realtime key returns bounded JSON.
- Realtime token upstream timeout returns bounded JSON.
- Missing Codex CLI returns bounded JSON.
- Unexpected Codex app-server payload returns bounded JSON.
- Unauthenticated Codex account state stays bounded.
- Slow Codex app-server response emits a timeout event.

## Manual Live Checklist

These checks still require a live desktop pass before an MVP tag:

- App menu launch by clicking the **Codex** desktop icon.
- Microphone permission grant and denied-permission behavior.
- Speaker output during a live Realtime session.
- Realtime voice start, cancel, mute/unmute, stop, transcript save, and reopened-thread transcript review.
- Live WebRTC connection setup failure behavior against the real Realtime API.
- Screen capture permission and visual-context injection.
- Voice-routed Codex task against a real external workspace.
- Generated HTML presentation written to the selected workspace and previewed in the temporary browser view.
- Subtle Codex agent activity while work is running.
- Settings weather lookup and voice weather result path once the upstream weather service returns live data.
- USB detection with the target Arduino-style board.
- Physical Arduino upload with an explicit detected port and LED behavior confirmation.

## Known Release Position

The automated MVP hardening contract is substantially covered. The remaining gap is not source-level evidence; it is OS permission, realtime media, and physical hardware behavior that must be observed on the target Linux desktop.
