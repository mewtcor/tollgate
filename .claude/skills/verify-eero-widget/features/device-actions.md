# Device actions

Device actions let a user pause or resume a device, block it with a two-click confirmation, pause it for a set time, and apply the same actions to several ticked devices at once.

## Sub-features

- `act-pause` pauses and resumes one device from its card.
- `act-block` blocks only after a second click inside three seconds.
- `act-timer` pauses a device for a chosen time and shows when it resumes.
- `act-bulk` applies pause, timer or block to every ticked device.

## How to get to it (user POV)

- Use the `Pause` or `Block` button on a device card.
- Use the `Timer` dropdown on an online, unpaused card.
- Tick the checkbox at a card's top-left corner and use the bar that appears above the cards.

## Driving it with cdp.mjs

Preconditions:

- Signed in, as left by the [Sign in](./login.md) recipe. No device paused or blocked.

- **Pause.** Run `node $V/cdp.mjs click 'button[data-m="aa:00:00:00:00:01"][data-a="pause"]'`. Run `node $V/cdp.mjs wait "document.querySelector('button[data-m=\"aa:00:00:00:00:01\"][data-a=\"unpause\"]')"`. The card button now reads `Resume`. `__state` shows `paused: true` for `aa:00:00:00:00:01` and the log has a `PUT /2.3/networks/1001/devices/aa:00:00:00:00:01` with body `{"paused":true}`.
- **Resume.** Click the same button (now `data-a="unpause"`). `__state` shows `paused: false`.
- **Block needs two clicks.** Run the `click` on `button[data-m="aa:00:00:00:00:02"][data-a="block"]` once. Run `node $V/cdp.mjs eval "document.querySelector('button[data-m=\"aa:00:00:00:00:02\"][data-a=\"block\"]').textContent"`. It reads `Confirm?` and `__state` still shows `blacklisted: false`. Click again within three seconds. `__state` shows `blacklisted: true` and the log has `POST /2.2/networks/1001/blacklist`.
- **Timer.** Run `node $V/cdp.mjs fill 'select[data-timer="aa:00:00:00:00:03"]' '30'`. The card subtitle reads `Resumes ` followed by a time about 30 minutes ahead (`document.querySelector('.card .meta p')` of that card). `__state` shows `paused: true`.
- **Bulk.** Run `node $V/cdp.mjs click 'input[data-sel="aa:00:00:00:00:01"]'` and the same for `...:02`. Run `node $V/cdp.mjs eval "document.querySelector('#bulk-n').textContent"`. It reads `2 selected`. Click `#bulk [data-b="pause"]`. `__state` shows both devices paused.
- **Proof.** Run `node $V/cdp.mjs shot .verify/evidence/device-actions/<step>.png` after each step and save `__state` beside it.

## Gotchas

- `Confirm?` disarms after three seconds, and a 15 second device refresh can also reset the button. Send the second click straight after the first.
- The `Timer` select only exists on cards that are not paused and not blocked. After Pause it is replaced by the `Resume` button.
- A timer expiring cannot be waited out through the UI, because the shortest choice is 30 minutes. Shortcut, not a user path: `node $V/cdp.mjs eval "window.__TAURI__.core.invoke('pause_for', { mac: 'aa:00:00:00:00:01', minutes: 1 })"` then wait up to 100 seconds. `__state` shows `paused: false` again and the log has a second `PUT` with `{"paused":false}`.
- The offline device (`Old Tablet`) still shows `Timer` and `Pause`, and they still send requests.
