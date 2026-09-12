import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { hex } from './crypto';
import * as pair from './pair';
import { fromBase64url, fromHex, toBase64url } from './wire';

// den-spec, checked out at the repository root; the TV runs the same file.
const vectors = JSON.parse(
  readFileSync(new URL('../../../spec/vectors/pairing-v1.json', import.meta.url), 'utf8'),
) as {
  cpace: Record<
    'prs' | 'ci' | 'sid' | 'g' | 'ya' | 'ADa' | 'Ya' | 'yb' | 'ADb' | 'Yb' | 'K' | 'ISK',
    string
  > & {
    scalarMultVfy: { s: string; X: string; result: string };
    invalidPoints: string[];
  };
  codes: { input: string; parsed: { nameplate: string; secret: string } | null }[];
  pairing: Record<
    'secret' | 'sid' | 'joinerLabel' | 'hostLabel' | 'ya' | 'yb' | 'a' | 'b' | 'c',
    string
  > & {
    wrongSecret: { b: string };
    handover: { key: string; nonce: string; d: string };
    link: { linkKey: string; inbox: string; enc: string };
  };
};
const p = vectors.pairing;
const IDENTITY = '00'.repeat(32);
const handover: pair.Handover = {
  host: p.hostLabel,
  linkKey: fromHex(p.link.linkKey),
  libraryKey: Uint8Array.from({ length: 32 }, (_, i) => i),
};

describe('pairing v1 matches den-spec', () => {
  it("runs the CPace draft's ristretto255 vectors", async () => {
    const c = vectors.cpace;
    const g = await pair.generator(fromHex(c.prs), fromHex(c.ci), fromHex(c.sid));
    expect(hex(g.toBytes())).toBe(c.g);
    const Ya = pair.scalarMult(fromHex(c.ya), g);
    const Yb = pair.scalarMult(fromHex(c.yb), g);
    expect([hex(Ya), hex(Yb)]).toEqual([c.Ya, c.Yb]);
    expect([
      hex(pair.scalarMultVfy(fromHex(c.ya), Yb)),
      hex(pair.scalarMultVfy(fromHex(c.yb), Ya)),
    ]).toEqual([c.K, c.K]);
    const isk = await pair.intermediateKey(
      fromHex(c.sid),
      fromHex(c.K),
      Ya,
      fromHex(c.ADa),
      Yb,
      fromHex(c.ADb),
    );
    expect(hex(isk)).toBe(c.ISK);
    const { s, X, result } = c.scalarMultVfy;
    expect(hex(pair.scalarMultVfy(fromHex(s), fromHex(X)))).toBe(result);
    for (const bad of c.invalidPoints)
      expect(hex(pair.scalarMultVfy(fromHex(s), fromHex(bad)))).toBe(IDENTITY);
  });

  it.each(vectors.codes)('reads the code $input', ({ input, parsed }) => {
    expect(pair.parseCode(input)).toEqual(parsed);
  });

  it('groups a code as it is typed and keeps the cursor after the same characters', () => {
    expect(pair.formatCode('abcd')).toEqual({ text: 'ABCD', caret: 4 });
    expect(pair.formatCode('ABCDE')).toEqual({ text: 'ABCD-E', caret: 6 });
    expect(pair.formatCode('ab cd-ef gh jkLM NP')).toEqual({ text: 'ABCD-EFGH-JKLM', caret: 14 });
    expect(pair.formatCode('AB0O1ICD')).toEqual({ text: 'ABCD', caret: 4 });
    expect(pair.formatCode('ABCDXEFGH', 5)).toEqual({ text: 'ABCD-XEFG-H', caret: 6 });
    expect(pair.formatCode('ABCD-EFGH', 4)).toEqual({ text: 'ABCD-EFGH', caret: 4 });
    expect(pair.formatCode('')).toEqual({ text: '', caret: 0 });
  });

  it('plays both sides of the pinned pairing', async () => {
    const sid = fromHex(p.sid);
    const joiner = await pair.joinerStart(p.secret, sid, p.joinerLabel, fromHex(p.ya));
    expect(toBase64url(joiner.a)).toBe(p.a);
    const host = await pair.hostRespond(p.secret, sid, p.hostLabel, joiner.a, fromHex(p.yb));
    if (!host) throw new Error('the host refused a');
    expect([toBase64url(host.b), host.state.joiner]).toEqual([p.b, p.joinerLabel]);
    const finished = await pair.joinerFinish(joiner.state, host.b);
    if (!finished) throw new Error('the joiner refused b');
    expect([toBase64url(finished.c), finished.host, hex(finished.handoverKey)]).toEqual([
      p.c,
      p.hostLabel,
      p.handover.key,
    ]);
    expect(await pair.hostConfirm(host.state, finished.c)).toBe(true);

    const d = await pair.sealHandover(finished.handoverKey, handover, fromHex(p.handover.nonce));
    expect(toBase64url(d)).toBe(p.handover.d);
    expect(await pair.openHandover(finished.handoverKey, d)).toEqual(handover);
    expect(await pair.linkKeys(handover.linkKey)).toEqual({
      inbox: p.link.inbox,
      enc: fromHex(p.link.enc),
    });
  });

  it("stops at the host's message when the host has another secret", async () => {
    const joiner = await pair.joinerStart(p.secret, fromHex(p.sid), p.joinerLabel, fromHex(p.ya));
    expect(await pair.joinerFinish(joiner.state, fromBase64url(p.wrongSecret.b))).toBeNull();
  });

  it('refuses malformed messages and the identity share', async () => {
    const sid = fromHex(p.sid);
    const a = fromBase64url(p.a);
    const respond = (message: Uint8Array) =>
      pair.hostRespond(p.secret, sid, p.hostLabel, message, fromHex(p.yb));
    expect(await respond(Uint8Array.from([...a, 0]))).toBeNull();
    expect(await respond(a.slice(0, -1))).toBeNull();
    expect(
      await respond(
        pair.lvCat(
          a.slice(1, 33),
          pair.lvCat(new TextEncoder().encode('host'), new TextEncoder().encode('Mac')),
        ),
      ),
    ).toBeNull();
    expect(
      await respond(
        pair.lvCat(
          new Uint8Array(32),
          pair.lvCat(new TextEncoder().encode('joiner'), new TextEncoder().encode('Mac')),
        ),
      ),
    ).toBeNull();

    const joiner = await pair.joinerStart(p.secret, sid, p.joinerLabel, fromHex(p.ya));
    const b = fromBase64url(p.b);
    expect(await pair.joinerFinish(joiner.state, b.slice(0, -1))).toBeNull();
    expect(
      await pair.openHandover(fromHex(p.handover.key), fromBase64url(p.handover.d).slice(0, -1)),
    ).toBeNull();
  });
});

/** den-edge's /pair routes, with a TV behind them that answers as a host. */
function relay(secret: string, approve = true) {
  const sid = p.sid;
  const slots = new Map<string, string>();
  let opened = false;
  let gone = false;
  let host: pair.HostState | undefined;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (input === '/pair/open') {
      if (opened) return json(409, { error: 'already_opened' });
      opened = true;
      return json(200, { sid });
    }
    if (gone) return json(410, { error: 'expired_or_unknown' });
    const slot = input.split('/')[3] ?? '';
    if (method === 'DELETE') {
      gone = true;
      return json(200, { deleted: true });
    }
    if (method === 'PUT') {
      const m = (JSON.parse(String(init?.body)) as { m: string }).m;
      slots.set(slot, m);
      if (slot === 'a') {
        const answer = await pair.hostRespond(secret, fromHex(sid), p.hostLabel, fromBase64url(m));
        host = answer?.state;
        if (answer) slots.set('b', toBase64url(answer.b));
      }
      if (slot === 'c' && host) {
        if (approve && (await pair.hostConfirm(host, fromBase64url(m)))) {
          slots.set('d', toBase64url(await pair.sealHandover(host.handoverKey, handover)));
        } else gone = true;
      }
      return json(200, { written: true });
    }
    const m = slots.get(slot);
    return m ? json(200, { m }) : json(202, { status: 'pending' });
  }) as typeof fetch;
  return { fetchImpl, wasDeleted: () => gone };
}

/** den-edge's relay, in memory: `new` mints a nameplate for the host's sid, `open` trades it back, slots are
    write-once and answer 202 until written. */
function fakeEdge(nameplate = 'ABCD') {
  const slots = new Map<string, string>();
  let sid = '';
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, string>;
    if (url === '/pair/new') {
      sid = body.sid ?? '';
      return json(200, { nameplate });
    }
    if (url === '/pair/open')
      return body.nameplate === nameplate ? json(200, { sid }) : json(410, {});
    const slot = url.startsWith(`/pair/${sid}/`) ? url.slice(`/pair/${sid}/`.length) : null;
    if (!slot) return json(404, {});
    if (init?.method === 'PUT') {
      if (slots.has(slot)) return json(409, {});
      slots.set(slot, body.m ?? '');
      return json(200, { written: true });
    }
    const m = slots.get(slot);
    return m === undefined ? json(202, { status: 'pending' }) : json(200, { m });
  };
  return fetchImpl;
}

describe('hosting a pairing', () => {
  /** Both sides at once, as two browsers are: the host shows a code, the joiner types it. */
  async function pairThem(allow: (joiner: string) => Promise<boolean>, fetchImpl = fakeEdge()) {
    const libraryKey = new Uint8Array(32).fill(7);
    // A poll that yields to the timers, not a no-op: the two sides take turns here as two browsers do, and a
    // side that never yields spends its whole ten minutes of polls before the other writes a thing.
    const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
    let give: (code: string) => void = () => undefined;
    const code = new Promise<string>((resolve) => (give = resolve));
    const hosted = pair.host({
      libraryKey,
      label: 'Safari on Mac',
      onCode: give,
      allow,
      fetchImpl,
      wait,
    });
    const joined = pair.join(await code, { label: 'Chrome on Android', fetchImpl, wait });
    return {
      libraryKey,
      ...Object.fromEntries([
        ['host', await hosted],
        ['join', await joined],
      ]),
    };
  }

  it('hands this browser’s library to another, with no TV in it', async () => {
    const { host: hosted, join: joined, libraryKey } = await pairThem(async () => true);
    expect(hosted).toEqual({ joiner: 'Chrome on Android' });
    expect(joined).toHaveProperty('handover.host', 'Safari on Mac');
    const handover = (joined as { handover: pair.Handover }).handover;
    expect([...handover.libraryKey]).toEqual([...libraryKey]);
    expect(handover.linkKey).toHaveLength(32);
  });

  it('hands over nothing when the host refuses', async () => {
    const { host: hosted, join: joined } = await pairThem(async () => false);
    expect(hosted).toEqual({ error: 'failed' });
    expect(joined).toEqual({ error: 'failed' });
  });
});

describe('joining through den-edge', () => {
  const options = (fetchImpl: typeof fetch) => ({
    label: p.joinerLabel,
    fetchImpl,
    wait: async () => {},
  });

  it('gets the library and link keys once the TV allows it', async () => {
    const { fetchImpl } = relay(p.secret);
    const result = await pair.join('abcd efgh-jklm', options(fetchImpl));
    expect(result).toEqual({ handover, inboxKey: p.link.inbox });
  });

  it('fails, and ends the session, on a declined prompt or a wrong code', async () => {
    const declined = relay(p.secret, false);
    expect(await pair.join('ABCD-EFGH-JKLM', options(declined.fetchImpl))).toEqual({
      error: 'failed',
    });
    const wrong = relay('EFGHJKLN');
    expect(await pair.join('ABCD-EFGH-JKLM', options(wrong.fetchImpl))).toEqual({
      error: 'failed',
    });
    expect(wrong.wasDeleted()).toBe(true);
  });

  it('refuses a mistyped code without asking den-edge, and says why opening failed', async () => {
    const never = (async () => {
      throw new Error('no request expected');
    }) as typeof fetch;
    expect(await pair.join('ABCD-EFGH-JKL0', options(never))).toEqual({ error: 'mistyped' });
    const answering = (status: number) =>
      (async () => new Response('{}', { status })) as typeof fetch;
    expect(await pair.join('ABCD-EFGH-JKLM', options(answering(409)))).toEqual({
      error: 'claimed',
    });
    expect(await pair.join('ABCD-EFGH-JKLM', options(answering(410)))).toEqual({
      error: 'expired',
    });
    expect(await pair.join('ABCD-EFGH-JKLM', options(answering(429)))).toEqual({
      error: 'throttled',
    });
    expect(await pair.join('ABCD-EFGH-JKLM', options(never))).toEqual({ error: 'unreachable' });
  });

  it('says so, instead of hanging, on a page served without WebCrypto', async () => {
    const never = (async () => {
      throw new Error('no request expected');
    }) as typeof fetch;
    // A plain-http address has no `crypto.subtle`: the maths would throw between two written slots, leaving a code
    // on one screen and a spinner on the other.
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes });
    try {
      expect(await pair.join('ABCD-EFGH-JKLM', options(never))).toEqual({ error: 'insecure' });
      const hosting = {
        libraryKey: new Uint8Array(32),
        onCode: () => undefined,
        allow: async () => true,
      };
      expect(await pair.host({ ...hosting, fetchImpl: never })).toEqual({ error: 'insecure' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
