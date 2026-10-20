# Install Den on an LG or Samsung TV

Den's production TV endpoint is `https://den-tv.oxy.fi`. The LG app is a very small launcher for that hosted UI.
Samsung requires its UI inside a locally signed widget, so its package uses the existing
`https://d-api.oxy.fi` backend directly. Video continues over Den's signed media route; it is not sent through
Cloudflare Tunnel.

Opening `https://den-tv.oxy.fi/?tv-diagnostics=1` in a desktop browser is a useful availability check, but it does
not install anything and does not prove a TV decoder.

## LG webOS (C2 and C4)

The unavoidable local pieces are LG Developer Mode, its temporary developer key, and the one `ares-install` command.
The launcher does not contain Den itself, so later Den UI updates arrive from the hosted URL without reinstalling it.

1. On the TV install **Developer Mode** from the LG Content Store. Sign in with an LG developer account, enable
   **Dev Mode Status**, reboot, then enable **Key Server**. The Mac and TV must be on the same LAN.
2. On the Mac, from this repository's `web/` directory:

   ```sh
   npm install -g @webos-tools/cli@3.2.6
   ares-setup-device
   ```

   Choose `add`; name it `den-lg`, enter the TV's LAN address, port `9922`, user `prisoner`, and no password.
3. Fetch the TV's developer key, entering the six-character passphrase displayed by the Developer Mode app:

   ```sh
   ares-novacom --device den-lg --getkey
   ares-device --system-info --device den-lg
   ```

4. Build, install and launch the production launcher:

   ```sh
   npm exec --yes --package=@webos-tools/cli@3.2.6 -- \
     node scripts/tv-package.mjs webos \
     --url https://den-tv.oxy.fi/ --version 1.0.0
   ares-install --device den-lg tv-packages/webos/packages/com.den.edge.tv_1.0.0_all.ipk
   ares-launch --device den-lg com.den.edge.tv
   ```

For a launcher metadata change, increment `--version` (for example `1.0.1`) and run the last three commands again.
For live inspection run `ares-inspect --device den-lg --app com.den.edge.tv`. LG removes development-installed apps
when Developer Mode expires, so use **Extend** in that app before its timer runs out.

LG references: [Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app) and
[webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-dev-guide).

## Samsung Tizen 8 (2024-generation TV or newer)

Samsung requires a Samsung certificate whose distributor certificate includes that TV. That private certificate
cannot safely be generated or stored by Den's CI, so building/signing the `.wgt` is intentionally local.

1. Install Tizen Studio. In Package Manager install **Web CLI**, the current **TV Extensions**, and
   **Samsung Certificate Extension**. In Certificate Manager create a **Samsung** certificate profile; below it is
   called `DenSamsung`.
2. On the TV open **Apps**, open **App Settings**, type `12345`, enable Developer Mode, enter the Mac's LAN address,
   and reboot the TV.
3. In Tizen Studio Device Manager add the TV on port `26101`, connect it, then choose
   **Permit to install applications**. Confirm the command-line bridge can see it:

   ```sh
   sdb devices
   ```

4. From this repository's `web/` directory, build the production widget, sign it and install it. Replace
   `TV_SERIAL` with the first column printed by `sdb devices` and use the `.wgt` filename actually produced:

   ```sh
   npm ci --ignore-scripts
   DEN_TV_PACKAGED=1 DEN_TV_API_ORIGIN=https://d-api.oxy.fi npm run build:tv:tizen
   DEN_TV_API_ORIGIN=https://d-api.oxy.fi node scripts/tv-package.mjs tizen \
     --url https://d-api.oxy.fi --profile DenSamsung --version 1.0.0
   ls tv-packages/tizen/packages/*.wgt
   tizen install -s TV_SERIAL --name Den.wgt -- tv-packages/tizen/packages
   tizen run -s TV_SERIAL -p DenTvApp1X.Den
   ```

Increment `--version` for an update and repeat build, package and install. `sdb dlog` shows device logs. If signing
or installation is refused, re-open Device Manager and permit installation again, then verify that the active
Samsung certificate profile contains this TV's DUID. USB widget installation is not supported.

Samsung references: [connect a TV](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html)
and [Tizen CLI](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/command-line-interface.html?device=htv).

## Hosting/operator checks

After a den-edge update and tunnel configuration change:

```sh
curl -fsS https://den-tv.oxy.fi/ | grep -F '<title>Den</title>'
curl -fsS https://d-api.oxy.fi/version
curl -sS -D- -o /dev/null -H 'Origin: https://den-tv.oxy.fi' https://d-api.oxy.fi/config \
  | tr -d '\r' | grep -Fi 'access-control-allow-origin: https://den-tv.oxy.fi'
```

Do not put an interactive Cloudflare Access application in front of `den-tv.oxy.fi` or `d-api.oxy.fi`. The TV app
uses Den's own pairing/member credentials; a browser login page would break startup and background requests.
