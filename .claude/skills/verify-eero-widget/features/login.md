# Sign in

Sign in lets a user enter their Eero email or phone, confirm a code, and land on the dashboard showing their devices. A wrong code shows an error and keeps them on the code step.

## Sub-features

- `login-request` sends the code request and reveals the code field.
- `login-wrong-code` shows an error for a bad code.
- `login-verify` accepts the code and shows the device list.

## How to get to it (user POV)

- Launch the app while signed out. The `Sign in to eero` screen appears.
- Use the sign-out button in the title bar (`#logout`) to return to it.

## Driving it with cdp.mjs

Preconditions:

- Fresh `start` state, signed out.

- **Request code.** Run `node $V/cdp.mjs fill '#user' 'test@example.com'` then `node $V/cdp.mjs click '#f-user button[type=submit]'`. Run `node $V/cdp.mjs wait "!document.querySelector('#f-code').hidden"`. The code field `#code` is visible.
- **Wrong code.** Run `node $V/cdp.mjs fill '#code' '000000'` then `node $V/cdp.mjs click '#f-code button[type=submit]'`. Run `node $V/cdp.mjs eval "document.querySelector('#login-err').textContent"`. The text contains `invalid code` and the sign-in screen stays.
- **Correct code.** Run `node $V/cdp.mjs fill '#code' '123456'` then `node $V/cdp.mjs click '#f-code button[type=submit]'`. Run `node $V/cdp.mjs wait "document.querySelectorAll('.card').length === 4"`. Four device cards show, including `Old Tablet`.
- **Proof.** Run `node $V/cdp.mjs shot .verify/evidence/login/dashboard.png` and save `Invoke-RestMethod http://127.0.0.1:8787/__state` to `.verify/evidence/login/state.json`. The log holds `POST /2.2/login`, `POST /2.2/login/verify` and `GET /2.2/networks/1001/devices`.

## Gotchas

- The page persists the session to the verify data dir, so a second sign-in run without `stop` then `start` begins already signed in. Use the `#logout` button, or restart.
- `wait` returns as soon as the expression is truthy. After the correct code the dashboard first shows no cards for a moment, so always wait for the card count.
