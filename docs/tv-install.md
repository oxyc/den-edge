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

1. On the TV install **Developer Mode** from the LG Content Store. Sign in with an LG developer account, enable
   **Dev Mode Status**, reboot, then enable **Key Server**. Note the TV's IP address and the six-character key-server
   passphrase. The Mac and TV must be on the same LAN.
2. On the Mac, install [Node.js 24 LTS](https://nodejs.org/) if `node --version` does not already work. Download and
   extract [`den-tv-webos.tar.gz`](https://github.com/oxyc/den-edge/releases/latest/download/den-tv-webos.tar.gz),
   then run its installer with the TV's IP:

   ```sh
   cd ~/Downloads
   tar -xzf den-tv-webos.tar.gz
   ./den-tv-webos/install.sh TV_IP
   ```

   Enter the six-character passphrase when asked. The script downloads LG's CLI if needed, registers the TV,
   obtains its developer key, installs Den, and opens it.

### LG updates and Developer Mode expiry

- **Ordinary Den updates need no reinstall.** The launcher always opens `https://den-tv.oxy.fi`, so UI fixes and
  features arrive the next time Den loads. Reinstall only when release notes explicitly mention an LG launcher
  change, or after the TV has removed the app.
- The current Developer Mode app commonly starts with **999 hours (about 41 days)**, but the countdown shown on the
  TV is authoritative; LG documents it as a limited session rather than guaranteeing a fixed duration. The installer
  cannot renew it. Before it reaches zero, open Developer Mode and press **Extend**. It does not renew itself.
- If the timer reaches zero, it is too late to extend: LG disables Developer Mode and removes development-installed
  apps. Enable Developer Mode/Key Server again and rerun the same installer. LG also says ten reboots while the TV is
  offline disable Developer Mode.

LG references: [Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app),
[webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-dev-guide), and
[LG staff on the 999-hour counter](https://forum.webostv.developer.lge.com/t/topic/4854/2).

## Samsung Tizen 8 (2024-generation TV or newer)

Samsung requires a Samsung certificate whose distributor certificate includes that TV. That private certificate
cannot safely be generated or stored by Den's CI, so building/signing the `.wgt` is intentionally local.

1. Install Tizen Studio. In Package Manager install **Web CLI**, the current **TV Extensions**, and
   **Samsung Certificate Extension**. In Certificate Manager create a **Samsung** certificate profile; below it is
   called `DenSamsung`.
2. On the TV open **Apps**, open **App Settings**, type `12345`, enable Developer Mode, enter the Mac's LAN address,
   and reboot the TV.
3. In Tizen Studio Device Manager add the TV on port `26101` and connect it. Confirm the command-line bridge can
   see it:

   ```sh
   sdb devices
   ```

4. Download [`den-tv-tizen-unsigned.tar.gz`](https://github.com/oxyc/den-edge/releases/latest/download/den-tv-tizen-unsigned.tar.gz),
   extract it, and run its installer. Replace
   `TV_SERIAL` with the first column printed by `sdb devices`; `DenSamsung` is the certificate profile from step 1:

   ```sh
   cd ~/Downloads
   tar -xzf den-tv-tizen-unsigned.tar.gz
   cd den-tv-tizen
   ./install.sh DenSamsung TV_SERIAL
   ```

The release contains the already-built app, but not a universal Samsung signature: Samsung requires the distributor
certificate to contain your TV's DUID. The installer permits installation, signs the app for that TV, installs it,
and opens it. For an update, download the current archive and rerun the same command. `sdb dlog` shows device logs.
If signing is refused, verify that the active Samsung certificate profile contains this TV's DUID. USB widget
installation is not supported.

### Samsung updates and certificates

- Samsung's app contains the TV bundle rather than loading it from `den-tv.oxy.fi`. Backend/service changes arrive
  without reinstalling, but **TV UI changes require downloading the current archive and rerunning `install.sh`**.
- Back up the Samsung author certificate, its password, and the certificate profile. Samsung requires an update to
  use the same author certificate as the installed app; the distributor certificate must be valid and contain this
  TV's DUID when an update is signed and installed.
- There is no LG-style 999-hour app-removal timer documented for this Samsung flow. Developer Mode and a reachable TV
  are needed when installing an update; the installer runs the installation-permit command each time.

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
