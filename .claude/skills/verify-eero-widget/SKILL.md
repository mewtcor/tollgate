---
name: verify-eero-widget
description: Launch the Tollgate desktop app (Tauri 2, WebView2, Windows) against a fake Eero server, drive its real UI over the debugger, and capture proof. Use to confirm any change to src/main.rs or ui/ works in the running app.
---

# Verify Tollgate

Tollgate is a Tauri 2 desktop app. The UI is static HTML in `ui/`, the backend is `src/main.rs`, and the backend talks to Eero's cloud. Verification runs a debug build of the app against a fake Eero server (`scripts/mock-eero.mjs`), so nothing here can pause, block or schedule a real device.

Read `features/README.md` first, then use the matching feature file as the recipe.

All commands run from the repo root in PowerShell. Set `$V = ".claude/skills/verify-eero-widget/scripts"` once.

## Isolation

The verify build is compiled with `TAURI_CONFIG` setting the identifier to `dev.mewt.eero-widget.verify` into `target-verify/`. That gives it its own app data dir, WebView2 profile (so its `localStorage` is separate) and single-instance lock. A real Tollgate that the user has running (or sitting in the tray) is unaffected and must not be killed. Two verify runs cannot overlap, because the ports 8787 and 9333 are fixed and `start` refuses when they are busy.

## Launch

```
powershell -NoProfile -File $V/verify.ps1 doctor     # preflight, read-only
powershell -NoProfile -File $V/verify.ps1 start      # build, start fake Eero + app, wait for the login screen
```

**Process lifetime.** `start` launches the app and the fake server as children of the calling shell. Many agent shells kill their children when a command returns, so the instance may be gone by the next call. Run `start`, every drive step and `stop` inside one shell command (a single script or a `;`-chained command), or check with `doctor` before each separate call. Do not pipe `start` into another command such as `| tail`: the app inherits the pipe, which then never closes and the command hangs. Send its output to a file instead.

**Visible window.** The verify build opens a real window titled `Tollgate`, wired to fake data. Tell the user it is a test instance, because it looks like their app and they may type real credentials into it. Those requests go only to the local fake server, but they then appear in its `__state` log.

`start` wipes the verify identifier's data dirs first, so every run begins signed out with no schedules. The first build compiles all dependencies into `target-verify/` and takes several minutes. Later builds take seconds. It prints `ready: ...` only once the login screen is visible. It records both pids in `.verify/run.json`.

Fake Eero accepts any email or phone, and the code `123456`. It serves four devices: `Test Laptop`, `Test Phone`, `Test Console` (wired) and `Old Tablet` (offline), with MACs `aa:00:00:00:00:01` to `04`.

## Doctor

```
powershell -NoProfile -File $V/verify.ps1 doctor
```

With no run in progress it checks Node 22+, cargo, and that the ports are free. With a run in progress it checks that the verify build and the fake server are alive and that the debugger sees the `Tollgate` page. Run it first whenever anything looks off. A `FAIL` line means do not drive.

## Drive

`scripts/cdp.mjs` talks to the app's page over the WebView2 debugger:

```
node $V/cdp.mjs eval  '<js expression>'
node $V/cdp.mjs wait  '<js expression>' [ms]
node $V/cdp.mjs click '<css selector>'
node $V/cdp.mjs fill  '<css selector>' '<value>'
node $V/cdp.mjs key   '<css selector>' Enter
node $V/cdp.mjs shot  <path.png>
```

Stable handles are element ids (`#user`, `#code`, `#sm`, `#sa`, `#st`, `#gname`) and data attributes (`data-m` and `data-a` on card buttons, `data-sel`, `data-timer`, `data-tog`, `data-edit`, `data-del`, `data-g`). Cards render devices as `.card`. Do not drive by coordinates.

## Evidence

Write proof under `.verify/evidence/<feature>/`. Cleanup never removes it.

- Exercise the real UI path. Do not call backend commands through `invoke` except where a feature file marks it as a shortcut.
- Capture the action and the result: a screenshot (`cdp.mjs shot`) plus a DOM fact from `eval`.
- Prove side effects from the second view. The fake server's state is that view: `Invoke-RestMethod http://127.0.0.1:8787/__state` returns every device's `paused` and `blacklisted` flags plus the log of requests the app made. Save it next to the screenshot, after dropping log entries from before your run began, since they can hold anything typed into the window. For anything stored locally, read `localStorage` through `eval`.
- A UI change that has no matching request in the log did not reach Eero.

## Cleanup

```
powershell -NoProfile -File $V/verify.ps1 stop
```

Stops the app (and its WebView2 children) and the fake server by the pids recorded in `.verify/run.json`, after checking the app process is still the verify build. It never kills by process name, so a real Tollgate keeps running. It deletes the verify identifier's data dirs and keeps `.verify/evidence/`, `.verify/mock.log` and `.verify/app.log`. Run it after a failed attempt too.

The verify instance adds a tray icon. Windows can leave a ghost icon in the tray after a hard kill. It disappears on mouse-over.

## Not covered

Tray menu, hide-on-close and Start with Windows are OS-level and cannot be driven over the debugger. Verify them by hand.
