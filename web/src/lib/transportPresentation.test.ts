import { describe, expect, it } from 'vitest';
import { PARAMETER_FALLBACKS, type ParameterMessageId } from './messages/parameters';
import { parameters as es } from './messages/parameters/es';
import { parameters as sv } from './messages/parameters/sv';

const format = (
  catalog: Readonly<Record<ParameterMessageId, string>>,
  id: ParameterMessageId,
  device = 'Apple TV',
) => catalog[id].replaceAll('{device}', device);

describe('wake transport presentation', () => {
  it('ships parameterized English, Spanish and Swedish waking state', () => {
    expect(format(PARAMETER_FALLBACKS, 'playback.waking')).toBe('Waking Apple TV…');
    expect(format(es, 'playback.waking')).toBe('Activando Apple TV…');
    expect(format(sv, 'playback.waking')).toBe('Väcker Apple TV…');
  });

  it('ships localized confirmation and durable recovery outcomes', () => {
    expect(format(es, 'playback.sentUnconfirmed')).toBe(
      'Enviado a Apple TV, pero la reproducción no está confirmada.',
    );
    expect(format(sv, 'playback.wakeRetryFailed')).toBe(
      'Det gick inte att nå Apple TV efter att den väcktes.',
    );
    expect(format(PARAMETER_FALLBACKS, 'playback.wakeUnconfirmed')).toBe(
      'Couldn’t confirm Apple TV woke. Open Den and try again.',
    );
  });
});
