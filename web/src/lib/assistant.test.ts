import { expect, test, vi } from 'vitest';
import { drainWhileOpen, type ApplyOutcome, type QueuedRequest } from './assistant';

const DROPBOX = { kid: '0123456789abcdef0123456789abcdef', public: 'pk-one' };

/** A den-edge whose queue answers `drains` in turn, then holds empty until the test stops the loop. */
function edge(drains: QueuedRequest[][]) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (path.startsWith('/assistant/drain')) {
      const next = drains.shift();
      if (!next) {
        await new Promise<void>((resolve) =>
          init?.signal?.addEventListener('abort', () => resolve()),
        );
        throw new DOMException('aborted', 'AbortError');
      }
      return Response.json({ messages: next });
    }
    if (path === '/assistant/ack') return Response.json({ removed: 1 });
    return new Response(null, { status: 204 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

async function run(
  drains: QueuedRequest[][],
  apply: (messages: QueuedRequest[]) => Promise<ApplyOutcome>,
) {
  const answered = drains.length;
  const { calls, fetchImpl } = edge(drains);
  const applied = vi.fn();
  const stop = new AbortController();
  const sleeps: number[] = [];
  const done = drainWhileOpen(
    {
      libraryId: 'lib',
      apply,
      applied,
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    },
    stop.signal,
  );
  // Every scripted answer handled, and the loop back waiting on den-edge.
  await vi.waitFor(() =>
    expect(calls.filter((c) => c.path.startsWith('/assistant/drain')).length).toBeGreaterThan(
      answered,
    ),
  );
  stop.abort();
  await done;
  return { calls, applied, sleeps };
}

test('a drain is applied, announced, acknowledged, and then held', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const accepted = {
    seq: 1,
    outcome: 'accepted' as const,
    op: 'watchlist_add',
    title: { type: 'movie' as const, id: 603 },
    detail: 'added %s to your watchlist',
  };
  const { calls, applied } = await run(
    [
      [
        { seq: 1, sealed: 'a' },
        { seq: 2, sealed: 'b' },
      ],
    ],
    async (messages) => {
      expect(messages.map((m) => m.seq)).toEqual([1, 2]);
      return {
        results: [accepted, { seq: 2, outcome: 'rejected', reason: 'revoked' }],
        ack: 2,
        dropbox: DROPBOX,
      };
    },
  );
  expect(applied).toHaveBeenCalledWith(accepted);
  // A refusal is logged by its reason alone, never as a toast.
  expect(info).toHaveBeenCalledWith('den: an assistant request was refused (revoked)');
  expect(calls.map((c) => c.path)).toEqual([
    '/assistant/drain',
    '/assistant/dropbox',
    '/assistant/ack',
    '/assistant/drain?wait=25',
  ]);
  expect(calls[1]?.body).toEqual({ pk: DROPBOX.public });
  expect(calls[2]?.body).toEqual({ upTo: 2 });
  info.mockRestore();
});

test('the drop-box key is given to den-edge again only when the library’s changes', async () => {
  const keys = [DROPBOX, DROPBOX, { ...DROPBOX, public: 'pk-two' }];
  const { calls } = await run([[], [], []], async () => ({
    results: [],
    ack: null,
    dropbox: keys.shift()!,
  }));
  expect(calls.filter((c) => c.path === '/assistant/dropbox').map((c) => c.body)).toEqual([
    { pk: 'pk-one' },
    { pk: 'pk-two' },
  ]);
  expect(calls.some((c) => c.path === '/assistant/ack')).toBe(false);
});

test('requests left unacknowledged are not drained again at once', async () => {
  const { sleeps, calls } = await run([[{ seq: 4, sealed: 'x' }]], async () => ({
    results: [],
    ack: null,
    dropbox: null,
  }));
  expect(sleeps).toContain(15_000);
  expect(calls.some((c) => c.path === '/assistant/ack')).toBe(false);
});

test('a library service that fails to apply backs off and acknowledges nothing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { sleeps, calls } = await run([[{ seq: 1, sealed: 'x' }]], async () => {
    throw new Error('worker gone');
  });
  expect(sleeps).toContain(60_000);
  expect(calls.some((c) => c.path === '/assistant/ack')).toBe(false);
  warn.mockRestore();
});
