# Schedules

Schedules let a user pause, resume, block or unblock devices at a set time on chosen days, switch a schedule off without deleting it, edit it, and delete it. While the app is running a due schedule is applied to Eero.

## Sub-features

- `sched-add` adds a schedule for one device, or one per ticked device.
- `sched-days` limits a schedule to chosen days.
- `sched-toggle` switches a schedule on or off.
- `sched-edit` changes an existing schedule in place.
- `sched-delete` removes a schedule.
- `sched-fire` applies a due schedule to Eero.

## How to get to it (user POV)

- Use the form under `Daily schedules` at the bottom of the dashboard.
- Use the checkbox, pencil and ✕ buttons on a schedule row.

## Driving it with cdp.mjs

Preconditions:

- Signed in with no schedules, as left by the [Sign in](./login.md) recipe.

- **Add.** Run `node $V/cdp.mjs fill '#sm' 'aa:00:00:00:00:01'`, `node $V/cdp.mjs fill '#sa' 'pause'`, `node $V/cdp.mjs fill '#st' '21:00'`, then `node $V/cdp.mjs click '#sched-submit'`. Run `node $V/cdp.mjs eval "document.querySelectorAll('#sched-list .sched').length"`. It is `1`, the row shows `Test Laptop`, `Every day` and `9:00 pm`. The dashboard's last tile shows the same time.
- **Days.** Run `node $V/cdp.mjs click '#days [data-p="1,2,3,4,5"]'` before adding. The row label reads `Weekdays`. Removing every chip then adding shows the toast `Pick at least one day` and adds nothing.
- **Toggle.** Run `node $V/cdp.mjs click '#sched-list [data-tog="0"]'`. The row gets class `off`, and the next-schedule tile reads `--` and `No schedules`. Click it again and it returns.
- **Edit.** Run `node $V/cdp.mjs click '#sched-list [data-edit="0"]'`. The submit button reads `Save`. Run `node $V/cdp.mjs fill '#st' '22:30'` then `node $V/cdp.mjs click '#sched-submit'`. The same row now reads `10:30 pm` and the list still has one row.
- **Delete.** Run `node $V/cdp.mjs click '#sched-list [data-del="0"]'`. The list is empty.
- **Fire.** Compute the next minute with `node $V/cdp.mjs eval "new Date(Date.now() + 60000).toTimeString().slice(0, 5)"`. Add a `pause` schedule for `aa:00:00:00:00:02` at that time. Run `node $V/cdp.mjs wait "document.querySelector('button[data-m=\"aa:00:00:00:00:02\"][data-a=\"unpause\"]')" 120000`. `__state` shows `paused: true` for `...:02` and the log has the matching `PUT`.
- **Proof.** Run `node $V/cdp.mjs shot` after each step, save `__state`, and save the stored schedules with `node $V/cdp.mjs eval "document.querySelector('#sched-list').innerText"`.

## Gotchas

- `#st` is a 24 hour `HH:MM` value even though the page shows am/pm. Fill it as `21:00`, not `9:00 pm`.
- A schedule only fires in the minute it is due. If the check runs late (up to 20 seconds) it still catches that minute, but a schedule added with the current minute as its time never fires.
- With devices ticked, `#sm` is disabled and the form adds one schedule per ticked device. Untick or use `Clear` first for the single-device steps.
- The fire step takes up to about 80 seconds. Do not shorten the wait.
