import { expect, test } from 'vitest';
import { maturityLines, parseTitleFacts } from './titleFacts';

// The same cases DenKit's MaturityProvenanceTests hold the Apple apps to: published labels lead in atlas's order, a
// live provider's observation follows unless it repeats a published one, the line names authority, label, cut and
// jurisdiction, and the normalized age is never shown.
const kavi = { authority: 'KAVI', authorityId: 'kavi', rating: 'K-16', normalizedAge: 16 };

test('published labels lead, a live observation follows, an identical one is shown once', () => {
  expect(
    maturityLines({
      maturityRatings: [kavi, { authority: 'IMDA', authorityId: 'imda', rating: 'M18' }],
      runtimeMaturityRatings: [
        { ...kavi, jurisdiction: 'fi' },
        {
          authority: 'IMDA',
          authorityId: 'imda',
          jurisdiction: 'sg',
          rating: 'R21',
          normalizedAge: 21,
        },
      ],
    }),
  ).toEqual(['KAVI K-16', 'IMDA M18', 'IMDA R21 (SG)']);
});

test('the line carries cut and jurisdiction, and never the normalized age', () => {
  const [line] = maturityLines({
    maturityRatings: [
      {
        authority: 'KAVI',
        authorityId: 'kavi',
        rating: 'K-12',
        normalizedAge: 12,
        runtimeMinutes: 101,
        format: 'theatrical',
      },
    ],
  });
  expect(line).toBe('KAVI K-12 (theatrical, 101 min)');
});

test('a malformed observation, or an atlas without the fields, is no label rather than a failure', () => {
  expect(
    maturityLines({
      maturityRatings: [
        kavi,
        { authority: '', authorityId: 'broken', rating: '12' },
        { authority: 'NFI', rating: '12' },
        null,
      ],
    }),
  ).toEqual(['KAVI K-16']);
  expect(maturityLines({})).toEqual([]);
  expect(parseTitleFacts({ type: 'movie', id: 1, indexed: true }).maturity).toEqual([]);
});
