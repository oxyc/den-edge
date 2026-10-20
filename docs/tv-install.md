# Install Den on an LG or Samsung TV

Den's production TV endpoint is `https://den-tv.oxy.fi`. The LG app is a very small launcher for that hosted UI.
Samsung requires its UI inside a locally signed widget, so its package uses the existing
`https://d-api.oxy.fi` device API and `https://d.oxy.fi` service routes directly. Video continues over Den's
signed media route; it is not sent through Cloudflare Tunnel.

Opening `https://den-tv.oxy.fi/?tv-diagnostics=1` in a desktop browser is a useful availability check, but it does
not install anything and does not prove a TV decoder.

## LG webOS (C2 and C4)

The launcher does not contain Den itself, so later Den UI updates arrive from the hosted URL without reinstalling it.
You only need to repeat installation if the small launcher itself changes or LG removes it when Developer Mode expires.

### Option 1: webOS Dev Manager

1. On the TV install **Developer Mode** from the LG Content Store. Sign in with an LG developer account, enable
   **Dev Mode Status**, reboot, then enable **Key Server**. Note the TV's IP address and the six-character key-server
   passphrase. The installer device and TV must be on the same LAN.
2. Install the appropriate desktop build—or the `universal.apk` on Android—from the
   [latest webOS Dev Manager release](https://github.com/webosbrew/dev-manager-desktop/releases/latest). It is a
   community GUI installer and does not require LG's SDK or IDE.
3. Download [`den-tv-webos.ipk`](https://github.com/oxyc/den-edge/releases/latest/download/den-tv-webos.ipk) directly
   from Den's latest GitHub release.
4. In webOS Dev Manager, add a Developer Mode device using the TV's IP and passphrase. Open its **Apps** view, choose
   **Install**, select `den-tv-webos.ipk`, and launch Den when installation finishes.

#### macOS walkthrough

1. From the [latest webOS Dev Manager release](https://github.com/webosbrew/dev-manager-desktop/releases/latest),
   download `webOS.Dev.Manager_VERSION_universal.dmg`. The universal build works on both Apple silicon and Intel
   Macs.
2. Open the `.dmg`, drag **webOS Dev Manager** to **Applications**, and launch it. If macOS blocks the first launch,
   Control-click the app in Finder, choose **Open**, and confirm. Allow Local Network access when macOS asks; if the
   TV cannot be found, check **System Settings › Privacy & Security › Local Network**.
3. Download [`den-tv-webos.ipk`](https://github.com/oxyc/den-edge/releases/latest/download/den-tv-webos.ipk); it will
   normally be in the Mac's **Downloads** folder.
4. With **Developer Mode** and **Key Server** enabled on the TV, open webOS Dev Manager and choose **Add Device**.
   Select the Developer Mode setup, enter any friendly name plus the TV's IP address and six-character passphrase,
   then finish the connection.
5. Select the connected TV, open **Apps**, click **Install**, and choose `Downloads/den-tv-webos.ipk`. When Den appears
   in the installed-app list, launch it there or from the TV's app launcher.
6. Before the Developer Mode countdown reaches zero, reconnect to the TV and use **Renew session** in its information
   view. This extends the session but does not turn renewal into an automatic background task.

### LG installation methods compared

| Method                              | Best for                                                      | What it requires                                                  | Developer Mode expiry                                                            |
| ----------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **webOS Dev Manager (recommended)** | A friend installing from a computer or Android phone          | Developer Mode, Key Server, the direct `.ipk`; no SDK or terminal | Can renew manually from the device's information view; the deadline still exists |
| **Den bundled installer**           | A semi-technical Mac/Linux user or repeatable troubleshooting | Node.js, a terminal and the release `.tar.gz`                     | Cannot renew the session                                                         |
| **LG webOS CLI/Studio**             | App development, logs and debugging                           | LG tooling plus manual device setup                               | Can extend the session, but adds substantial setup                               |
| **Root plus Homebrew Channel**      | A supported TV already intentionally rooted                   | Firmware-specific rooting and its recovery risk                   | Avoids Developer Mode expiry, but is not a supported Den installation path       |

### Option 2: Den bundled installer

The original terminal installer remains supported and continues to ship in every release. An existing Den
installation does not need to be replaced with the Dev Manager version; both methods install the same launcher.
Install
[Node.js 24 LTS](https://nodejs.org/) if `node --version` does not work, then:

```sh
cd ~/Downloads
curl -fLO https://github.com/oxyc/den-edge/releases/latest/download/den-tv-webos.tar.gz
tar -xzf den-tv-webos.tar.gz
./den-tv-webos/install.sh TV_IP
```

Enter the six-character passphrase when asked. The script downloads LG's CLI if needed, registers the TV, obtains its
developer key, installs Den, and opens it.

### LG updates and Developer Mode expiry

- **Ordinary Den updates need no reinstall.** The launcher always opens `https://den-tv.oxy.fi`, so UI fixes and
  features arrive the next time Den loads. Reinstall only when release notes explicitly mention an LG launcher
  change, or after the TV has removed the app.
- The current Developer Mode app commonly starts with **999 hours (about 41 days)**, but the countdown shown on the
  TV is authoritative; LG documents it as a limited session rather than guaranteeing a fixed duration. Before it
  reaches zero, use **Renew session** in webOS Dev Manager's device information view, or open Developer Mode on the TV
  and press **Extend**. Neither happens automatically.
- If the timer reaches zero, it is too late to extend: LG disables Developer Mode and removes development-installed
  apps. Enable Developer Mode/Key Server again and reinstall the `.ipk`. LG also says ten reboots while the TV is
  offline disable Developer Mode.

#### Optional automatic renewal

Community tools such as [`webos-dev-mode`](https://github.com/gabe565/webos-dev-mode) can run a daily cron task using
the TV's Developer Mode session token. This is not an LG-supported permanence mechanism: it depends on LG's remote
service, has varied with TV firmware, and must run before the current session expires. Treat the token like a
credential, keep it on a machine you control, and verify the countdown on the TV after setting it up. For a friend's
TV, manually pressing **Renew session** in webOS Dev Manager every few weeks is the lower-risk choice.

LG references: [Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app),
[webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop),
[webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-dev-guide), and
[LG staff on the 999-hour counter](https://forum.webostv.developer.lge.com/t/topic/4854/2).

## Samsung Tizen (2022-generation TV or newer)

The release publishes an unsigned `.wgt`; [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) creates the
Samsung certificate for the destination TV, signs the widget and installs it. The certificate is device-specific,
so Den's CI cannot publish one universally installable signed package.

1. Download the appropriate desktop build—or the `-android.apk`—from the
   [latest Apps2Samsung release](https://github.com/Apps2Samsung/Apps2Samsung/releases/latest). The installer device
   and TV must be on the same LAN.
2. Download the widget for the TV's model year:

   - **2024 or newer (Tizen 8+):** [`den-tv-tizen.wgt`](https://github.com/oxyc/den-edge/releases/latest/download/den-tv-tizen.wgt)
     (the same file is also published explicitly as `den-tv-tizen8.wgt`).
   - **2022–2023 (Tizen 6.5–7):** [`den-tv-tizen6.5.wgt`](https://github.com/oxyc/den-edge/releases/latest/download/den-tv-tizen6.5.wgt).

   The model year matters, not the purchase year. Samsung identifies it in the TV's support/about screen and model
   number.

3. On the TV open **Apps** and type `12345`, enable Developer Mode, enter the local IP address Apps2Samsung shows for
   the computer or phone, and restart the TV. If it is not discovered afterward, power-cycle it completely.
4. In Apps2Samsung select the TV, choose the custom `.wgt` option, select the downloaded Den widget, and install.
   Sign in with a free Samsung developer account when asked; Tizen 7 and newer require it when the tool provisions
   the certificate.

For an update, download the current `.wgt` from the same stable URL and install it again. Preserve Apps2Samsung's
data so it can reuse the author certificate. If the TV reports an author-certificate mismatch, remove its existing
Den installation and install again; removal can discard local app data.

Den does not currently publish a widget for 2021 or older models. The 2022 package is the low-risk compatibility
floor because Samsung's Tizen 6.5 engine is Chromium 85, which is also Den's compiled compatibility target. The 2021
and 2020 engines are Chromium 76 and 69; supporting them would require additional runtime polyfills and device-level
playback testing. Pre-2020 Samsung engines also lack the WebAssembly support Den's local database requires.

### Tizen Studio alternative

The release retains the Tizen 8 package's existing Tizen Studio installer for development and troubleshooting.
For a 2022–2023 TV, prefer Apps2Samsung and the versioned 6.5 widget above. Install Tizen Studio's
**Web CLI**, current **TV Extensions**, and **Samsung Certificate Extension**; create a Samsung certificate profile
whose distributor certificate includes the TV, enable Developer Mode as above, then connect the TV in Device Manager.
Download the unsigned archive and pass the profile name and the serial shown by `sdb devices` to its installer:

```sh
cd ~/Downloads
curl -fLO https://github.com/oxyc/den-edge/releases/latest/download/den-tv-tizen-unsigned.tar.gz
tar -xzf den-tv-tizen-unsigned.tar.gz
cd den-tv-tizen
./install.sh DenSamsung TV_SERIAL
```

The script permits installation, signs the app for that TV, installs it, and opens it. `sdb dlog` shows device logs.
USB widget installation is not supported.

### Samsung updates and certificates

- Samsung's app contains the TV bundle rather than loading it from `den-tv.oxy.fi`. Backend/service changes arrive
  without reinstalling, but **TV UI changes require installing the current `.wgt`**.
- Keep Apps2Samsung's data or export its backup. Samsung requires an update to use the same author certificate as the
  installed app; the distributor certificate must be valid and include this TV's DUID.
- Samsung sideloaded apps have no recurring expiry and normally survive reboots. A major TV firmware update can
  occasionally remove one; enable Developer Mode and install it again if that happens.

Samsung references: [connect a TV](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html),
[create and preserve certificates](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html),
and [Tizen CLI](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/command-line-interface.html?device=htv).

## Hosting/operator checks

After a den-edge update and tunnel configuration change:

```sh
curl -fsS https://den-tv.oxy.fi/ | grep -F '<title>Den TV</title>'
curl -fsS https://d-api.oxy.fi/version
curl -sS -D- -o /dev/null -H 'Origin: https://den-tv.oxy.fi' https://d-api.oxy.fi/config \
  | tr -d '\r' | grep -Fi 'access-control-allow-origin: https://den-tv.oxy.fi'
curl -sS -D- -o /dev/null -H 'Origin: https://den-tv.oxy.fi' https://d.oxy.fi/reel/health \
  | tr -d '\r' | grep -Fi 'access-control-allow-origin: https://den-tv.oxy.fi'
```

Do not put an interactive Cloudflare Access application in front of `den-tv.oxy.fi` or `d-api.oxy.fi`. The TV app
uses Den's own pairing/member credentials; a browser login page would break startup and background requests.
