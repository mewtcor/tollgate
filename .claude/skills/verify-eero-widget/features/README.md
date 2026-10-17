# Tollgate verification map

This directory is the maintained source for verifying the user-facing behavior of Tollgate. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- `verify.ps1 start` has printed `ready:` and `verify.ps1 doctor` reports no `FAIL`.
- The app is on the sign-in screen with no schedules, no nicknames, no groups, and no devices paused or blocked. `start` produces this state.
- Fake Eero serves `Test Laptop` (`aa:00:00:00:00:01`), `Test Phone` (`...:02`), `Test Console` (`...:03`, wired) and `Old Tablet` (`...:04`, offline).
- Never drive an instance that was not started by this verification run.

## Driving conventions

- `$V` is `.claude/skills/verify-eero-widget/scripts`. Commands are `node $V/cdp.mjs ...` and `powershell -NoProfile -File $V/verify.ps1 ...`.
- Start each recipe from the baseline state unless its preconditions say otherwise. Features after Sign in need the signed-in state, which the `login` recipe produces.
- Prefer element ids and data attributes over position.
- Treat every command as literal. Keep quoted values unchanged.
- Restore what a recipe changes, or finish with `verify.ps1 stop`. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a screenshot plus an `eval` of the DOM fact the recipe names.
- Anything that should reach Eero is proved by `http://127.0.0.1:8787/__state`: the device flag changed and the request appears in `log`.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with cdp.mjs`, `Gotchas`.

## Features

- [Sign in](./login.md) covers the two-step login, a wrong code, and the dashboard that follows.
- [Device actions](./device-actions.md) covers pause, resume, the two-click block, timers, and the bulk bar.
- [Schedules](./schedules.md) covers adding, day selection, on/off, editing, deleting, and a schedule actually firing.
- [Nicknames, groups and moving settings](./nicknames-groups.md) covers renaming, saved groups, and the changed-address helper.
