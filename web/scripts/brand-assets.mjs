// Repository-time provenance for every Edge-owned/copied/generated brand image. Keep paths repository-relative so
// this graph can be checked without a checkout of Den or a network request. `tv-icons.mjs` consumes `derived`
// directly: changing a renderer source or output therefore changes the same graph the conformance check verifies.
// Native Apple raster assets are generated and consumed in Den itself, never copied into this repository, so they
// are deliberately outside this Edge inventory.
export const brandAssets = {
  den: {
    repository: 'https://github.com/oxyc/den',
    revision: '97308fa758e0d7f63f955cf724617c7567d7175a',
    generator: 'scripts/gen-icon.swift (make icon)',
  },
  edgeGenerator: {
    path: 'web/scripts/tv-icons.mjs',
    sha256: '395eb07e3fdbaa427466e021132ef84c8e0bb072e2de3fee8fef280c8756c332',
  },
  copied: [
    {
      source: 'docs/brand/web/den-mark.svg',
      target: 'web/src/assets/den-mark.svg',
      sha256: '337fea263f5ba68f9c6189e3080284d2ab54d1e730c9603680feebe3de4b2f2a',
      consumers: [['web/src/components/NavigationBar.svelte', '../assets/den-mark.svg']],
    },
    {
      source: 'docs/brand/web/favicon.svg',
      target: 'web/public/favicon.svg',
      sha256: '81ff8e8abcfb0af1882b4c622a99b94917f4d6ae489ad901758f8c8f64673875',
      consumers: [['web/index.html', 'href="/favicon.svg"']],
    },
    {
      source: 'docs/brand/web/favicon-32.png',
      target: 'web/public/favicon-32.png',
      sha256: '5526e81f1666d7a366538911270d566ade11387a153a47011031fe65e064d254',
      consumers: [['web/index.html', 'href="/favicon-32.png"']],
    },
    {
      source: 'docs/brand/web/apple-touch-icon.png',
      target: 'web/public/apple-touch-icon.png',
      sha256: '3423c1da4dfd8965ce6212816355ceb9c4f750512ed7f4a92a8e493dc1f3efb0',
      consumers: [['web/index.html', 'href="/apple-touch-icon.png"']],
    },
    {
      source: 'docs/brand/web/icon-192.png',
      target: 'web/public/icon-192.png',
      sha256: '54ff20a8da7005158565e1a226fd27e32399c4d057d6e37ecc9c1d37b35bb34a',
      consumers: [['web/public/manifest.webmanifest', '"src": "/icon-192.png"']],
    },
    {
      source: 'docs/brand/web/icon-512.png',
      target: 'web/public/icon-512.png',
      sha256: 'f6533161c44d464080843e6556fc33495e2fad0d35ff90d894a86007e3339213',
      consumers: [['web/public/manifest.webmanifest', '"src": "/icon-512.png"']],
    },
    {
      source: 'docs/brand/web/icon-maskable-512.png',
      target: 'web/public/icon-maskable-512.png',
      sha256: '0d110e42ec0932b4c6457139d979a5ada09ef38ec446f8d789451bf06b6cd5d2',
      consumers: [['web/public/manifest.webmanifest', '"src": "/icon-maskable-512.png"']],
    },
  ],
  derived: [
    {
      id: 'tv-launcher-square',
      source: 'web/public/apple-touch-icon.png',
      renderer: 'Chromium screenshot at the target size, opaque background',
      outputs: [
        {
          target: 'web/tv-packaging/assets/icon-80.png',
          size: [80, 80],
          sha256: '0cad14c957e0c568f418fdaf1943624cc8a230d8e242eccdd3d392aecc50c7de',
          consumers: [['web/scripts/tv-package.mjs', "'icon-80.png'"]],
        },
        {
          target: 'web/tv-packaging/assets/icon-117.png',
          size: [117, 117],
          sha256: '967f6881584b60c00639d8968cbc636749e48ab8ef8e29d87316805b62d44115',
          consumers: [['web/scripts/tv-package.mjs', "'icon-117.png'"]],
        },
        {
          target: 'web/tv-packaging/assets/icon-130.png',
          size: [130, 130],
          sha256: '43d706f4b16da807ba8d7cdf1c10220de3aa85d2829a388aff67a8023ccce1a3',
          consumers: [['web/scripts/tv-package.mjs', "'icon-130.png'"]],
        },
      ],
    },
    {
      id: 'android-app-icon',
      source: 'web/public/favicon.svg',
      renderer: 'Chromium screenshot at 512×512 with transparency',
      outputs: [
        {
          target: 'android-tv/app/src/main/res/drawable-nodpi/app_icon.png',
          size: [512, 512],
          sha256: '7b30293c461632b0231daa243b76c2870b07d8ed6394ffdb943bd506091d9141',
          consumers: [['android-tv/app/src/main/AndroidManifest.xml', '@drawable/app_icon']],
        },
      ],
    },
    {
      id: 'android-banner',
      source: 'web/public/favicon.svg',
      renderer: 'Chromium screenshot at 320×180 with the Den label on #0b0b0f',
      outputs: [
        {
          target: 'android-tv/app/src/main/res/drawable-nodpi/tv_banner.png',
          size: [320, 180],
          sha256: '62285f1e9da2c4f0929d274a64fb9fd20267e85050c46be5113d0d4bb316a525',
          consumers: [['android-tv/app/src/main/AndroidManifest.xml', '@drawable/tv_banner']],
        },
      ],
    },
  ],
  local: [
    {
      target: 'web/public/og.png',
      provenance: 'Edge-owned social card, introduced by 164b14233197558eb43a61aded90a5e622eef658',
      sha256: '796f4640ee975c2df10f8ee93949095a4aabd7bf4b31e25e97b305d5fc19b828',
      consumers: [['web/index.html', 'content="/og.png"']],
    },
  ],
};
