import { describe, expect, it } from 'vitest';
import { ownerSplitCandidateWriteHeaders, ownerSplitWorkerRoute } from './profileOwnerSplitRoutes';

const HOUSEHOLD = '1'.repeat(32);
const ATTEMPT = 'a'.repeat(32);
const root = `/lib/${HOUSEHOLD}/profile-migration`;

describe('OwnerSplit Worker route boundary', () => {
  it.each([
    ['GET', `/lib/${HOUSEHOLD}/profile-capability`, 'capability'],
    ['GET', `${root}/source`, 'source'],
    ['POST', root, 'open'],
    ['GET', `${root}/${ATTEMPT}`, 'lookup'],
    ['DELETE', `${root}/${ATTEMPT}`, 'abort'],
    ['GET', `${root}/${ATTEMPT}/backup`, 'backup'],
    ['POST', `${root}/${ATTEMPT}/rows`, 'rows'],
    ['POST', `${root}/${ATTEMPT}/commit`, 'commit'],
    ['POST', `${root}/${ATTEMPT}/restore`, 'restore'],
    ['POST', `${root}/${ATTEMPT}/retire-candidate`, 'retire-candidate'],
  ] as const)('accepts only %s %s', (method, path, kind) => {
    expect(ownerSplitWorkerRoute(HOUSEHOLD, method, path)).toMatchObject({ kind });
  });

  it.each([
    ['GET', root],
    ['POST', `${root}/source`],
    ['GET', `${root}/source?attempt=${ATTEMPT}`],
    ['DELETE', root],
    ['POST', `${root}/${ATTEMPT}`],
    ['DELETE', `${root}/${ATTEMPT}/backup`],
    // den-edge creates the backup when it opens the attempt; Web may only read it.
    ['POST', `${root}/${ATTEMPT}/backup`],
    ['GET', `${root}/${ATTEMPT}/rows`],
    ['GET', `${root}/${ATTEMPT}/retire-candidate`],
    ['POST', `${root}/${ATTEMPT}/retire-candidate/extra`],
    ['POST', `${root}/${ATTEMPT}/retire-candidate?token=nope`],
    ['POST', `${root}/${ATTEMPT}/../${ATTEMPT}/retire-candidate`],
    ['POST', `${root}/${ATTEMPT}/%2e%2e/retire-candidate`],
    ['POST', `${root}/${ATTEMPT}//retire-candidate`],
    ['POST', `/lib/${'2'.repeat(32)}/profile-migration`],
  ] as const)('rejects noncanonical or confused %s %s', (method, path) => {
    expect(ownerSplitWorkerRoute(HOUSEHOLD, method, path)).toBeNull();
  });

  it('uses existing household membership to create the candidate library', () => {
    const headers = ownerSplitCandidateWriteHeaders(
      { id: HOUSEHOLD, member: 'household-member' },
      { token: 'candidate-token' },
    );
    expect(headers).toMatchObject({
      'x-den-library-token': 'candidate-token',
      'x-den-library-member': `${HOUSEHOLD}:household-member`,
      'x-den-wire': '4',
      'x-den-wire-min': '4',
      'x-den-generation': '0',
    });
    expect(headers['x-den-library-member']).not.toContain('candidate-token');
  });
});
