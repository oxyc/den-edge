import { expect, test } from 'vitest';
import { activeHomeFixture, REPRESENTATIVE_HOME_FIXTURE } from './activeHomePayload.testFixture';

const fixture = await activeHomeFixture(REPRESENTATIVE_HOME_FIXTURE);

test('active Home worker reply with v4 episode history', async ({ bench }) => {
  const current = bench('current projection graph clone', () =>
    structuredClone(fixture.currentReply),
  );
  const activeHome = bench('active Home payload clone', () => structuredClone(fixture.payload));
  const results = await bench.compare(current, activeHome);
  expect(results.get('active Home payload clone')).toBeFasterThan(
    results.get('current projection graph clone'),
  );
});
