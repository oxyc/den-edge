// Where the dev and preview servers proxy API requests.
//
// An e2e run (`DEN_E2E=1`, set by the Playwright configs for their web servers) must never reach a real den-edge,
// atlas, reel or remux. The homelab address these default to IS production: a request a spec does not route
// — WebKit's `sendBeacon` skips Playwright's routing — lands on the live service, and a fixture's playback outcome
// (`tv-fixture.mkv`) was recorded there. So under e2e the default is a dead local port, and an override
// must be loopback; anything else throws when the config loads.
const DEAD_END = 'http://127.0.0.1:9';

export function upstream(variable: string, fallback: string): string {
  const given = process.env[variable];
  if (process.env.DEN_E2E !== '1') return given ?? fallback;
  const target = given ?? DEAD_END;
  const host = new URL(target).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]')
    throw new Error(
      `${variable}=${target} is not loopback; an e2e run may not proxy to a real service`,
    );
  return target;
}
