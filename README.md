# Tollgate

Tollgate is a Windows desktop app that controls the devices on your eero mesh Wi-Fi network. From one window you can pause, resume, block, and unblock devices, set timers, and run daily schedules. It can also run around the clock on a Linux box and serve the same screen to any browser; see [Run it 24/7 on Linux](#run-it-247-on-linux).

![Tollgate showing four devices, a row of statistics, and the Daily schedules panel. The device names and addresses are sample data.](docs/screenshot.png)

I built Tollgate as a parent. I had too little time to switch off my kids' internet by hand, so I made the app do it on a schedule. Unlike eero's profile schedules, Tollgate's work per device or group. In the desktop app they run only while it is open; the Linux server runs them around the clock.

This guide is for people who use the app. To build it from source, run `cargo build --release` and open `target/release/tollgate.exe`.

## Install

1. Download `Tollgate_0.1.1_x64-setup.exe` from the [latest release](https://github.com/mewtcor/tollgate/releases/latest).
2. Run the installer.
3. If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**. The installer is not code-signed, so Windows warns about every new download.

The installer is for 64-bit Windows. I tested it only on Windows 11.

## Sign in

1. Open Tollgate.
2. Enter the email address or phone number on your eero account.
3. Click **Send code**. Eero sends you a code.
4. Enter the code and click **Verify**.

The device list appears and refreshes every 15 seconds. The app stays signed in until you click **Sign out** in the title bar.

## Pause or block a device

Each device has a card with a **Pause** button and a **Block** button.

- **Pause** cuts the device off from the internet. Click **Resume** to restore it.
- **Block** keeps the device off your network. Click **Block** a second time within 3 seconds to confirm. Click **Unblock** to let it back on.

To find a device, use the **All**, **Online**, **Paused**, and **Blocked** filters, or type in the search box.

## Pause a device for a set time

To pause a device and resume it automatically, choose a time from the **Timer** list on its card: 30 min, 1 hour, 2 hours, or 4 hours.

The timer survives a restart of the app. If you resume the device yourself before the time is up, the timer is cancelled.

## Rename a device

Double-click the device name, type a new name, and press Enter. The name is stored by Tollgate only. Eero and the eero app keep the original name.

## Act on several devices at once

1. Tick the checkbox on each card you want.
2. Use the bar that appears: **Pause**, **Resume**, **Timer**, **Block**, or **Unblock**.

To reuse a selection, type a name in the **Group name** box and click **Save group**. Click a group chip to select all of its devices. Click the **×** on a chip to delete the group. Groups are stored by Tollgate only.

## Schedule an action

Schedules repeat every week on the days you pick.

1. In **Daily schedules**, choose the days. Click **Weekdays**, **Weekends**, or **Every day** for a shortcut.
2. Choose a device, an action, and a time.
3. Click **Add**.

If you have devices selected, the schedule applies to all of them. To edit a schedule, click its pencil icon. To turn a schedule off without deleting it, clear its checkbox.

## Keep it running in the background

Timers and schedules run only while the app is running. Closing the window hides it in the system tray and keeps it running. Click the tray icon to show the window again.

Right-click the tray icon for these options:

- **Show** opens the window.
- **Start with Windows** starts the app hidden when you sign in to Windows.
- **Quit** stops the app, its timers, and its schedules.

To keep the window above other windows, click the pin icon in the title bar.

## Move settings to a device with a new address

When a device reconnects under a new entry, its schedules, nickname, and groups stay with the old entry. Open **Device got a new address?**, choose the old and the new entry, and click **Move settings**.

## Spot new devices

The first time you sign in, Tollgate asks whether to mark the devices it finds as known. After that, any device that joins gets a **New** tag on its card. The tag stays until you click it or rename the device.

If the new device has the same name or maker as a device that has schedules but is no longer on the network, Tollgate offers to move those settings. It never moves them on its own.

Tollgate identifies a device by its MAC address, so a change of IP address does not affect it. It cannot stop someone who changes or copies a MAC address. Phones and Windows 11 can use a private Wi-Fi address that changes when the network is forgotten and joined again. To avoid this, turn off the private address for your home Wi-Fi on your children's devices. Then lock that setting with Screen Time on iPhone or Family Link on Android.

## Where the app stores data

Your sign-in session, schedules, timers, and device names, groups and new-device tags are in `%APPDATA%\dev.mewt.eero-widget` (`session.txt`, `schedules.json`, `timers.json`, `prefs.json`). Delete `session.txt` there to sign out by hand. Earlier versions kept names, groups and new-device tags inside the window; the first start of this version moves them into `prefs.json`.

Tollgate saves the session in `session.txt` as plain text. Anyone who can read your Windows user profile can use it to act on your eero account. Click **Sign out** in the title bar to delete it when you stop using the app.

## Run it 24/7 on Linux

The desktop app runs timers and schedules only while it is open. `tollgate-server` runs them all the time on an always-on Linux machine, such as an old Mac mini or a Raspberry Pi, and serves the same screen to any browser on your network. It is one file with the UI built in, and it needs no desktop.

### Install

On the Linux machine (Debian, Ubuntu or Linux Mint; other distros with systemd work the same way):

1. Install the build tools: `sudo apt install build-essential git`, then Rust: `curl --proto '=https' -sSf https://sh.rustup.rs | sh`.
2. Get the code: `git clone https://github.com/mewtcor/tollgate && cd tollgate`.
3. Run `./deploy/install.sh`. It builds the server, creates a `tollgate` system user, installs `/etc/systemd/system/tollgate.service`, asks you for a password for the web page, and starts the service.
4. Open `http://<the machine's address>:8787` on your phone or PC. Your browser asks for the password; any user name works.
5. Sign in to eero as in the desktop app, or copy your existing sign-in over (next section).

To update, run `git pull` and `./deploy/install.sh` again. Your sign-in, schedules and settings stay.

### Move over from the desktop app

1. On Windows, update Tollgate to this version and open it once, so it moves your device names and groups into `prefs.json`.
2. Quit Tollgate from the tray and turn off **Start with Windows**. If both run, both fire your schedules.
3. Copy `session.txt`, `schedules.json`, `timers.json` and `prefs.json` from `%APPDATA%\dev.mewt.eero-widget` to the Linux machine, then:

```bash
sudo systemctl stop tollgate
sudo install -o tollgate -g tollgate -m 600 session.txt schedules.json timers.json prefs.json /var/lib/tollgate/
sudo systemctl start tollgate
```

The desktop app's **Sign out** only deletes its own `session.txt`, so the copied session keeps working.

### Prepare the machine

- **Time zone.** Schedules use the machine's local time. Check it with `timedatectl` and set it with `sudo timedatectl set-timezone Pacific/Auckland` (your zone).
- **No sleep.** `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`, and set the desktop's power settings to never suspend.
- **Wired network** if you can. The machine controls your Wi-Fi, so it should not depend on it.
- **Power on after a power cut.** On a Mac mini 2010, `deploy/mac-mini-2010-autopower.service` sets this at each boot. Read the comment in it first, then: `sudo cp deploy/mac-mini-2010-autopower.service /etc/systemd/system/ && sudo systemctl enable --now mac-mini-2010-autopower`. Other models need a different setting. Test it by pulling the plug.

### Check on it

- `systemctl status tollgate` shows whether it runs. `journalctl -u tollgate -f` shows each schedule and timer as it fires, sign-ins, and errors.
- `curl http://localhost:8787/api/health` needs no password and answers `ok`, `signed_in` and the time of the scheduler's last pass. If eero ends the session, `signed_in` turns false and the log says so; sign in again from the web page.

### Settings

`tollgate-server` reads these environment variables. The service file sets the first two, and `/etc/tollgate.env` holds the password.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOLLGATE_DATA` | `/var/lib/tollgate` | Folder for the session, schedules, timers and settings |
| `TOLLGATE_BIND` | `127.0.0.1:8787` | Address and port to listen on; `0.0.0.0:8787` for your whole network |
| `TOLLGATE_PASSWORD` | none | Password for the web page. Required unless it listens on localhost only |

### Keep it private

Anyone who can open the page can pause and block your devices, so keep the password and do not forward port 8787 on your router. The page uses plain HTTP, so the password crosses your home network unencrypted. To use Tollgate away from home, put the machine and your phone on [Tailscale](https://tailscale.com) and open the page over that.

To build the server elsewhere: `cargo build --release -p tollgate-server` gives `target/release/tollgate-server`. It has no system library dependencies beyond the C library.

## Disclaimer

Tollgate is not made by or affiliated with eero or Amazon. "eero" is a trademark of its owner.

Tollgate talks to eero's unofficial cloud API. eero can change or block that API at any time, which can stop Tollgate from working. Use it at your own risk and follow eero's terms of service.
