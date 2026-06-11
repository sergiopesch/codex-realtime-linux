# MVP Verification Record

Date: 2026-06-11

Status: automated release gates passed; MVP is not complete until the manual live checklist below is run and recorded on the target desktop.

## Automated Evidence

- Branch: `main`
- Base commit before this verification update: `a65b32d`
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm test`: passed, 122 tests.
- `npm run smoke:degraded`: passed.
- `npm run smoke:desktop`: passed with user service restart.
- `npm run smoke:renderer`: passed.
- `npm audit --omit=dev`: passed, 0 vulnerabilities.
- Desktop API status: passed at `http://127.0.0.1:3311/api/status`; `appRoot` returned `/home/sergiopesch/codex-realtime-linux`.

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
- Settings weather lookup and voice weather result path.
- USB detection with the target Arduino-style board.
- Physical Arduino upload with an explicit detected port and LED behavior confirmation.

## Known Release Position

The automated MVP hardening contract is substantially covered. The remaining gap is not source-level evidence; it is OS permission, realtime media, and physical hardware behavior that must be observed on the target Linux desktop.
