# TV packaging templates

`scripts/tv-package.mjs webos --url https://your-tv-host/` writes a hosted LG
launcher into `tv-packages/webos/shell` and invokes LG's `ares-package` to put
the `.ipk` in its sibling `packages` directory. It never modifies `dist-tv-*`.
The checked-in 80×80 and 130×130 icons are rendered from `public/favicon.svg`
by `node scripts/tv-icons.mjs`.

The generated app is a remote-content shell. It contains no credentials and
never installs or deploys to a device.

Samsung has a separate web preview build, but packaged Tizen routing, media
integration and signing are not implemented. The `tizen` package command fails
explicitly instead of generating a misleading hosted `.wgt`.

See [local setup and testing](../../docs/smart-tv.md).
