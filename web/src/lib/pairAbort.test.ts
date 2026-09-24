import { expect, it } from 'vitest';
import { host, join } from './pair';

// pair.test.ts pins den-spec's vectors and needs spec/; this needs none.
const SID = '0123456789abcdef0123456789abcdef';

/** den-edge with a pairing nobody else joins: every slot is still empty (202). */
function waitingEdge() {
  const asked: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/pair/new') return new Response('{"nameplate":"ABCD"}', { status: 200 });
    if (url === '/pair/open') return new Response(JSON.stringify({ sid: SID }), { status: 200 });
    if (init?.method === 'PUT' || init?.method === 'DELETE') return new Response('{}');
    return new Response('{}', { status: 202 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

it('stops waiting for a joiner once the page that hosts the pairing goes, and ends the session', async () => {
  const { asked, fetchImpl } = waitingEdge();
  const leaving = new AbortController();
  let polls = 0;
  const result = await host({
    libraryKey: new Uint8Array(32),
    label: 'Mac',
    onCode: () => undefined,
    allow: async () => true,
    fetchImpl,
    sid: SID,
    signal: leaving.signal,
    wait: async () => {
      if (++polls === 3) leaving.abort();
    },
  });
  expect(result).toEqual({ error: 'failed' });
  expect(polls).toBe(3);
  expect(asked.at(-1)).toBe(`DELETE /pair/${SID}`);
});

it('stops waiting for the TV once the page that joins goes', async () => {
  const { asked, fetchImpl } = waitingEdge();
  const leaving = new AbortController();
  let polls = 0;
  const result = await join('ABCD-EFGH-JKLM', {
    fetchImpl,
    signal: leaving.signal,
    wait: async () => {
      if (++polls === 3) leaving.abort();
    },
  });
  expect(result).toEqual({ error: 'failed' });
  expect(polls).toBe(3);
  expect(asked.at(-1)).toBe(`DELETE /pair/${SID}`);
});
