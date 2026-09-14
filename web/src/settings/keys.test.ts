import { describe, expect, it } from 'vitest';
import { KEY_SERVICES, keyStatus } from './keys';

const service = (name: string) => {
  const found = KEY_SERVICES.find((s) => s.name === name);
  if (!found) throw new Error(name);
  return found;
};
const answering = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const offline = (async () => {
  throw new TypeError('Failed to fetch');
}) as unknown as typeof fetch;

describe('key checks', () => {
  it('takes a key the service answers, and refuses one it turns away', async () => {
    expect(await service('tmdb').check('K', answering(200))).toBe('accepted');
    expect(await service('tmdb').check('K', answering(401))).toBe('refused');
    expect(await service('omdb').check('K', answering(200, { Response: 'True' }))).toBe('accepted');
    expect(await service('omdb').check('K', answering(200, { Response: 'False' }))).toBe('refused');
    // A search doesthedogdie finds nothing for is still a working key.
    expect(await service('doesthedogdie').check('K', answering(404))).toBe('accepted');
    expect(await service('doesthedogdie').check('K', answering(403))).toBe('refused');
  });

  it('says so when there is no answer, rather than calling the key bad', async () => {
    expect(await service('tmdb').check('K', offline)).toBe('unreachable');
    expect(await service('omdb').check('K', answering(503))).toBe('unreachable');
  });

  it('names a row as the TV does', () => {
    expect(keyStatus(false, undefined)).toBe('Not set');
    expect(keyStatus(true, 'checking')).toBe('Checking…');
    expect(keyStatus(true, 'refused')).toBe('Not accepted');
    expect(keyStatus(true, 'unreachable')).toBe('Not responding');
    expect(keyStatus(true, 'accepted')).toBe('Connected');
    expect(keyStatus(true, undefined)).toBe('Connected');
  });
});
