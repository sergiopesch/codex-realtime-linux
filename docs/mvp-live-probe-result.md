# MVP Live Environment Probe

Generated: 2026-06-11T09:42:55.870Z
API: http://127.0.0.1:3311
Status: usable

Summary: 11 passed, 3 warnings, 0 failed.

| Probe | Status | Evidence |
| --- | --- | --- |
| Git state | warn | branch=main; commit=8c30db8; dirty=true. |
| Desktop service | pass | codex-realtime-linux-app.service is active. |
| Desktop entry | pass | /home/sergiopesch/.local/share/applications/codex-realtime-linux.desktop; mode 755; size 391 bytes. |
| Desktop icon | pass | /home/sergiopesch/.local/share/icons/hicolor/512x512/apps/codex-realtime-linux.png; mode 664; size 194668 bytes. |
| Desktop launch log | pass | /home/sergiopesch/.local/state/codex-realtime-linux/desktop-launch.log; mode 600; size 108046 bytes. |
| API server log | pass | /home/sergiopesch/.local/state/codex-realtime-linux/api-server.log; mode 600; size 76725 bytes. |
| Desktop entry contents | pass | Name, launcher, and terminal mode are correct. |
| API status | pass | HTTP 200; appRoot=/home/sergiopesch/codex-realtime-linux; realtime=true; openAiKeySource=settings; usb.active=true; arduino.available=true. |
| Realtime token endpoint | pass | HTTP 200; response bytes 6062; token body intentionally not recorded. |
| USB watcher | pass | HTTP 200; active=true; detected events=0. |
| Arduino status | warn | HTTP 200; cli.available=true; boards=0; ports=0; command=/home/sergiopesch/codex-realtime-linux/bin/arduino-cli. |
| Weather route | warn | HTTP 502; code=weather_forecast_network_error; error=The weather service took too long to respond.. |
| Audio devices | pass | pactl sources=3; wpctl default source=true; wpctl default sink=true. |
| Video devices | pass | wpctl video source detected=true. This does not prove Electron screen-capture permission. |

## Scope

This probe records machine-observable state only. It does not prove microphone permission acceptance, speaker audibility, screen-share permission UX, realtime conversation quality, generated-workspace artifact correctness, or physical Arduino LED behavior. Those checks still require `npm run verify:manual`.
