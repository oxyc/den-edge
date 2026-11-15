import { expect, it } from 'vitest';
import { i18n, setInterfaceLanguage } from './i18n.svelte';

it('rejects a first-load catalog superseded before its import settles', async () => {
  await setInterfaceLanguage('en');
  const spanish = setInterfaceLanguage('es');
  const english = setInterfaceLanguage('en');

  await Promise.all([spanish, english]);

  expect(i18n.language).toBe('en');
  expect(i18n.text('player.subtitleTiming')).toBe('Subtitle timing');
});

it('formats re-sync controls and notices from each live locale catalog', async () => {
  const cases = [
    {
      language: 'en',
      audioVideo: 'Re-sync audio & video',
      withAudio: 'Re-sync with audio',
      starting: 'Re-syncing subtitles with audio…',
      success: 'Subtitles re-synced · -10.0s',
      spokenOffset: '+0.5 seconds',
      failure: 'Subtitles could not be re-synced. Your current timing is unchanged.',
    },
    {
      language: 'es',
      audioVideo: 'Resincronizar audio y vídeo',
      withAudio: 'Resincronizar con el audio',
      starting: 'Resincronizando los subtítulos con el audio…',
      success: 'Subtítulos resincronizados · -10,0s',
      spokenOffset: '+0,5 segundos',
      failure:
        'No se pudieron resincronizar los subtítulos. La sincronización actual no ha cambiado.',
    },
    {
      language: 'sv',
      audioVideo: 'Synkronisera om ljud och bild',
      withAudio: 'Synkronisera om med ljudet',
      starting: 'Synkroniserar om undertexter med ljudet…',
      success: 'Undertexter har synkroniserats om · −10,0s',
      spokenOffset: '+0,5 sekunder',
      failure:
        'Det gick inte att synkronisera om undertexterna. Din nuvarande synkronisering är oförändrad.',
    },
  ] as const;

  for (const expected of cases) {
    await setInterfaceLanguage(expected.language);
    const offset = i18n.format('player.subtitleOffsetCompact', '{sign}{offset}s', {
      sign: '',
      offset: new Intl.NumberFormat(i18n.language, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(-10),
    });
    expect(i18n.phrase('Re-sync audio & video')).toBe(expected.audioVideo);
    expect(i18n.phrase('Re-sync with audio')).toBe(expected.withAudio);
    expect(i18n.phrase('Re-syncing subtitles with audio…')).toBe(expected.starting);
    expect(`${i18n.phrase('Subtitles re-synced')} · ${offset}`).toBe(expected.success);
    expect(
      i18n.format('player.subtitleOffsetSpoken', '{sign}{offset} seconds', {
        sign: '+',
        offset: new Intl.NumberFormat(i18n.language, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(0.5),
      }),
    ).toBe(expected.spokenOffset);
    expect(i18n.phrase('Subtitles could not be re-synced. Your current timing is unchanged.')).toBe(
      expected.failure,
    );
  }
});

it('localizes the reduced-TV guest administration handoff', async () => {
  const cases = [
    {
      language: 'en',
      title: 'Manage guests in a supported browser',
      detail: 'Guest administration is not available on this TV',
      route:
        'In Den on a browser linked to this household, open Settings › Sharing to invite, extend, limit, relink, or revoke a guest.',
    },
    {
      language: 'es',
      title: 'Administrar invitados en un navegador compatible',
      detail: 'La administración de invitados no está disponible en este televisor',
      route:
        'En Den, en un navegador vinculado a este hogar, abre Ajustes › Compartir para invitar, ampliar, limitar, volver a vincular o revocar a un invitado.',
    },
    {
      language: 'sv',
      title: 'Hantera gäster i en webbläsare som stöds',
      detail: 'Gästadministration är inte tillgänglig på den här TV:n',
      route:
        'Öppna Inställningar › Delning i Den i en webbläsare som är länkad till hushållet för att bjuda in, förlänga, begränsa, länka om eller återkalla en gäst.',
    },
  ] as const;

  for (const expected of cases) {
    await setInterfaceLanguage(expected.language);
    expect(i18n.phrase('Manage guests in a supported browser')).toBe(expected.title);
    expect(i18n.phrase('Guest administration is not available on this TV')).toBe(expected.detail);
    expect(
      i18n.phrase(
        'In Den on a browser linked to this household, open Settings › Sharing to invite, extend, limit, relink, or revoke a guest.',
      ),
    ).toBe(expected.route);
  }
});
