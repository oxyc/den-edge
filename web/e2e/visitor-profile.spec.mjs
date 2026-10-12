import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

const FIRST = '11111111111111111111111111111111';
const SECOND = '22222222222222222222222222222222';

test('inactive Visitor sessions survive close and end only through explicit disposal', async ({
  page,
}) => {
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await guardNetwork(page);
  await page.goto(`${E2E_ORIGIN}/test/visitor-profile.html`);
  await page.waitForFunction(() => window.denVisitorFixture);

  const created = await page.evaluate(
    async ({ first, second }) => {
      localStorage.clear();
      localStorage.setItem('den.owner.untouched', 'owner');
      const one = window.denVisitorFixture.create(first);
      const two = window.denVisitorFixture.create(second);
      await window.denVisitorFixture.set(first, 'progress:movie:550', { fraction: 0.25 });
      await window.denVisitorFixture.set(second, 'progress:movie:550', { fraction: 0.75 });
      window.denVisitorFixture.close(first);
      return { one, two };
    },
    { first: FIRST, second: SECOND },
  );

  await page.reload();
  await page.waitForFunction(() => window.denVisitorFixture);
  requests.length = 0;
  const result = await page.evaluate(
    async ({ first, second }) => {
      window.denVisitorFixture.create(first);
      window.denVisitorFixture.create(second);
      const restored = {
        one: window.denVisitorFixture.get(first, 'progress:movie:550'),
        two: window.denVisitorFixture.get(second, 'progress:movie:550'),
      };
      const outbound = await window.denVisitorFixture.outbound(first);
      await window.denVisitorFixture.endVisit(first);
      await window.denVisitorFixture.endVisit(first);
      return {
        restored,
        outbound,
        keys: Object.keys(localStorage).sort(),
        survivor: window.denVisitorFixture.get(second, 'progress:movie:550'),
        owner: localStorage.getItem('den.owner.untouched'),
      };
    },
    { first: FIRST, second: SECOND },
  );

  expect(created.one).toMatchObject({ kind: 'visitor', libraryKey: null, retainedScope: null });
  expect(created.one.prefix).not.toBe(created.two.prefix);
  expect(result.restored).toEqual({ one: { fraction: 0.25 }, two: { fraction: 0.75 } });
  expect(result.outbound).toEqual([{ outcome: 'suppressed' }, { outcome: 'suppressed' }]);
  expect(result.keys).toEqual([
    'den.owner.untouched',
    `den.profile.visitor.v1:${SECOND}:progress:movie:550`,
  ]);
  expect(result.survivor).toEqual({ fraction: 0.75 });
  expect(result.owner).toBe('owner');
  expect(requests).toEqual([]);
});
