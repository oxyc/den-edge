import { describe, expect, it } from 'vitest';
import { denLifecycleMedia, lanHttpMedia, managedMedia, signedMedia } from '../../cast/src/media';

const path = `/remux/s/${'A'.repeat(22)}/${'b'.repeat(22)}/master.m3u8`;

describe('signed media URLs the Cast sender accepts', () => {
  it('takes a signed playlist on an IPv4 or IPv6 literal', () => {
    expect(signedMedia(`https://203.0.113.7${path}`)).toBe(true);
    expect(signedMedia(`https://[2001:db8::7]${path}`)).toBe(true);
  });

  it('takes a signed playlist on a dotted DNS name', () => {
    expect(signedMedia(`https://a7f3k9x2.media.example${path}`)).toBe(true);
    expect(signedMedia(`https://Media.Example.com${path}`)).toBe(true);
  });

  it('refuses a single-label or malformed host', () => {
    expect(signedMedia(`https://localhost${path}`)).toBe(false);
    expect(signedMedia(`https://intranet${path}`)).toBe(false);
    expect(signedMedia(`https://-bad.example${path}`)).toBe(false);
  });

  it('takes plain HTTP only on a receiver-reachable private LAN host', () => {
    for (const host of ['10.0.0.8', '172.20.1.8', '192.168.86.8', 'hearth.local']) {
      expect(signedMedia(`http://${host}:8090${path}`), host).toBe(true);
      expect(lanHttpMedia(`http://${host}:8090${path}`), host).toBe(true);
    }
    for (const host of ['127.0.0.1', 'localhost', '169.254.1.8', '203.0.113.7', 'media.example']) {
      expect(signedMedia(`http://${host}:8090${path}`), host).toBe(false);
      expect(lanHttpMedia(`http://${host}:8090${path}`), host).toBe(false);
    }
  });

  it('refuses another path, credentials, URL decorations, and malformed input', () => {
    expect(signedMedia(`http://203.0.113.7${path}`)).toBe(false);
    expect(signedMedia('https://203.0.113.7/remux/s/short/short/master.m3u8')).toBe(false);
    expect(signedMedia('https://media.example/other/master.m3u8')).toBe(false);
    expect(signedMedia(`https://user:secret@media.example${path}`)).toBe(false);
    expect(signedMedia(`https://media.example${path}?copy=1`)).toBe(false);
    expect(signedMedia(`https://media.example${path}#fragment`)).toBe(false);
    expect(signedMedia('not a url')).toBe(false);
  });
});

describe('managed media URLs the Cast sender accepts', () => {
  it('takes only credential-free HTTPS TorBox CDN capabilities with scrobbling disabled', () => {
    expect(
      managedMedia(
        'https://video.eu.tb-cdn.io/stream/master.m3u8?token=signed&scrobbling_enabled=false',
      ),
    ).toBe(true);
    expect(managedMedia('https://user:secret@video.eu.tb-cdn.io/x?scrobbling_enabled=false')).toBe(
      false,
    );
    expect(managedMedia('http://video.eu.tb-cdn.io/x?scrobbling_enabled=false')).toBe(false);
    expect(managedMedia('https://tb-cdn.io/x?scrobbling_enabled=false')).toBe(false);
    expect(managedMedia('https://video.eu.tb-cdn.io:444/x?scrobbling_enabled=false')).toBe(false);
    expect(managedMedia('https://video.eu.tb-cdn.io/x?scrobbling_enabled=true')).toBe(false);
    expect(managedMedia('https://video.eu.tb-cdn.io/x')).toBe(false);
    expect(managedMedia('https://video.eu.tb-cdn.io/x?scrobbling_enabled=false#secret')).toBe(
      false,
    );
    expect(managedMedia('https://tb-cdn.io.example/x?scrobbling_enabled=false')).toBe(false);
  });
});

describe('Cast media lifecycle ownership during replacements', () => {
  const direct = {
    url: 'https://video.eu.tb-cdn.io/stream/master.m3u8?scrobbling_enabled=false',
    external: true,
  };
  const remux = {
    url: `https://media.example${path}`,
    external: false,
  };
  const lanRemux = { url: `http://192.168.86.8:8090${path}`, external: false };
  const publicControlledLanRemux = {
    ...lanRemux,
    lifecycleUrl: `https://media.example${path}`,
  };
  const receipt = {
    ...lanRemux,
    lifecycleUrl: `https://media.example/den/_receipt/${'A'.repeat(43)}`,
  };

  it('does not turn the old managed URL into a Den endpoint while Remux is preparing', () => {
    const playing = direct;
    const current = remux;
    expect(current.external).toBe(false);
    expect(denLifecycleMedia(playing)).toBeNull();
  });

  it('still owns the old Remux lifecycle while managed playback is preparing', () => {
    const playing = remux;
    const current = direct;
    expect(current.external).toBe(true);
    expect(denLifecycleMedia(playing)).toBe(remux.url);
  });

  it('leaves a LAN HTTP Remux lifecycle with the parent page', () => {
    expect(denLifecycleMedia(lanRemux)).toBeNull();
  });

  it('uses HTTPS lifecycle control while the receiver reads the LAN HTTP alias', () => {
    expect(denLifecycleMedia(publicControlledLanRemux)).toBe(publicControlledLanRemux.lifecycleUrl);
  });

  it('accepts only an exact HTTPS receipt lifecycle capability', () => {
    expect(denLifecycleMedia(receipt)).toBe(receipt.lifecycleUrl);
    expect(
      denLifecycleMedia({ ...receipt, lifecycleUrl: receipt.lifecycleUrl + '?leak=1' }),
    ).toBeNull();
    expect(
      denLifecycleMedia({
        ...receipt,
        lifecycleUrl: receipt.lifecycleUrl.replace('https:', 'http:'),
      }),
    ).toBeNull();
  });
});
