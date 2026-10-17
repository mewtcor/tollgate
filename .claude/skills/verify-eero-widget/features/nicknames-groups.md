# Nicknames, groups and moving settings

Nicknames let a user rename a device, groups let them save a ticked set of devices under a name, and the changed-address helper moves a device's schedules, nickname and groups to a new device. All three are stored in the app only and never sent to Eero.

## Sub-features

- `nick-rename` renames a device by double-clicking its name.
- `nick-reset` clears a nickname.
- `group-save` saves the ticked devices as a named group.
- `group-use` ticks a group's members from its chip, and the ✕ deletes the group.
- `swap-move` moves settings from one device entry to another.

## How to get to it (user POV)

- Double-click a device name on its card.
- Tick devices, then use the `Group name` box and `Save group`.
- Open `Device got a new address?` at the bottom of the dashboard.

## Driving it with cdp.mjs

Preconditions:

- Signed in with no nicknames or groups, as left by the [Sign in](./login.md) recipe.

- **Rename.** Run `node $V/cdp.mjs eval "document.querySelector('h3[data-mac=\"aa:00:00:00:00:01\"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"`. Run `node $V/cdp.mjs fill '.nick' 'Dad Laptop'` then `node $V/cdp.mjs key '.nick' Enter`. The card heading reads `Dad Laptop`, and the schedule dropdown option for that MAC reads `Dad Laptop`. Reading `localStorage.getItem('nicks')` through `eval` holds the MAC and `Dad Laptop`.
- **Reset.** Double-click again, fill an empty value, press Enter. The heading returns to `Test Laptop`.
- **Save group.** Run `node $V/cdp.mjs click 'input[data-sel="aa:00:00:00:00:01"]'` and the same for `...:02`. Run `node $V/cdp.mjs fill '#gname' 'Kids'` then `node $V/cdp.mjs click '#group-form button[type=submit]'`. A chip named `Kids · 2` appears and `localStorage.getItem('groups')` lists both MACs.
- **Use group.** Run `node $V/cdp.mjs click '#bulk-clear'`. Run `node $V/cdp.mjs click '#group-chips [data-g="Kids"]'`. `#bulk-n` reads `2 selected`. Click the chip again and it reads `0 selected`.
- **Delete group.** Run `node $V/cdp.mjs click '#group-chips [data-gdel="Kids"]'`. The chip is gone.
- **Move settings.** Give `aa:00:00:00:00:04` (`Old Tablet`) a schedule and a nickname first, using the [Schedules](./schedules.md) recipe and the Rename steps. Run `node $V/cdp.mjs eval "document.querySelector('#swap').open = true"`. Run `node $V/cdp.mjs fill '#sw-from' 'aa:00:00:00:00:04'`, `node $V/cdp.mjs fill '#sw-to' 'aa:00:00:00:00:03'`, then `node $V/cdp.mjs click '#swap-form button[type=submit]'`. A toast reads `Moved 1 schedule, nickname to ...`, the schedule row now names `Test Console`'s nickname or name, and the nickname shows on `Test Console`'s card.
- **Proof.** Run `node $V/cdp.mjs shot` after each step and save `localStorage` values from `eval`.

## Gotchas

- While a name is being edited the grid does not re-render, so a refresh cannot wipe the edit. Finish with Enter, Escape or blur before reading other cards.
- `swap-move` needs `#swap` opened first, since the dropdowns are only filled while it is open.
- `localStorage` belongs to the verify build's WebView2 profile, not a real install. `start` wipes it.
- Escape cancels a rename. Setting `value` without the `key ... Enter` call does not save.
