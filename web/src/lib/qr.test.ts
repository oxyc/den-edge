import { expect, test } from 'vitest';
import { qrCode } from './qr';

test('a QR code is a square of modules drawn as one path', () => {
  const code = qrCode(
    'https://den.example/#phone=a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA&k=' + 'x'.repeat(43),
  );
  // Version 1 is 21 modules; 4n + 17 for every version after.
  expect((code.size - 17) % 4).toBe(0);
  expect(code.size).toBeGreaterThan(21);
  expect(code.path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  // The finder pattern's corner module is always dark.
  expect(code.path.startsWith('M0 0h1v1h-1z')).toBe(true);
  expect(qrCode('a').size).toBe(21);
});
