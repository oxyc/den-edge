import { describe, expect, it } from 'vitest';
import { fetchSimklClientId, pollToken, requestPin } from './simkl';

const answering = (status: number, body: unknown, seen: string[] = [], headers: Headers[] = []) =>
  (async (input: string, init?: RequestInit) => {
    seen.push(input);
    headers.push(new Headers(init?.headers));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

describe('SIMKL sign-in', () => {
  it("reads the client id den-edge publishes, and none when it doesn't", async () => {
    expect(await fetchSimklClientId(answering(200, { simklClientId: ' abc ' }))).toBe('abc');
    expect(await fetchSimklClientId(answering(200, {}))).toBeNull();
    expect(await fetchSimklClientId(answering(404, {}))).toBeNull();
  });

  it('asks for a code with the client id, in the query and the header SIMKL wants', async () => {
    const seen: string[] = [];
    const headers: Headers[] = [];
    const pin = await requestPin(
      'client-1',
      answering(
        200,
        {
          result: 'OK',
          user_code: 'AB12C',
          verification_url: 'https://simkl.com/pin/',
          interval: 5,
          expires_in: 900,
        },
        seen,
        headers,
      ),
    );
    expect(pin).toEqual({
      userCode: 'AB12C',
      verificationUrl: 'https://simkl.com/pin/',
      interval: 5,
      expiresIn: 900,
    });
    expect(seen).toEqual(['https://api.simkl.com/oauth/pin?client_id=client-1']);
    expect(headers[0]?.get('simkl-api-key')).toBe('client-1');
    expect(await requestPin('client-1', answering(412, { error: 'client_id_failed' }))).toBeNull();
  });

  it('waits, slows down, and takes the token once the code is entered', async () => {
    expect(
      await pollToken(
        'c',
        'AB12C',
        answering(200, { result: 'KO', message: 'Authorization pending' }),
      ),
    ).toEqual({
      kind: 'pending',
    });
    expect(
      await pollToken('c', 'AB12C', answering(200, { result: 'KO', message: 'Slow down' })),
    ).toEqual({
      kind: 'slowDown',
    });
    expect(
      await pollToken('c', 'AB12C', answering(200, { result: 'OK', access_token: 'tok' })),
    ).toEqual({
      kind: 'authorized',
      token: 'tok',
    });
    expect(await pollToken('c', 'AB12C', answering(500, {}))).toEqual({ kind: 'failed' });
  });
});
