import { expect, it } from 'vitest';
import { groupFilmographyByRole, parseFilmography } from './detail';
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

it('localizes truthful broader-profile capability notices', async () => {
  const cases = [
    {
      language: 'en',
      browser:
        'Rename, delete, and Adult profile creation are not available yet. They will be managed here in Den on the web.',
      tv: 'Rename, delete, and Adult profile creation are not available on this TV. They will be managed in Den on the web.',
      tizen3: 'This TV is viewer-only. Profile administration is not available on this TV.',
    },
    {
      language: 'es',
      browser:
        'El cambio de nombre, la eliminación y la creación de perfiles de adulto aún no están disponibles. Se administrarán aquí, en Den en la web.',
      tv: 'El cambio de nombre, la eliminación y la creación de perfiles de adulto no están disponibles en este televisor. Se administrarán en Den en la web.',
      tizen3:
        'Este televisor es solo para visualización. La administración de perfiles no está disponible en este televisor.',
    },
    {
      language: 'sv',
      browser:
        'Det går inte att byta namn på, ta bort eller skapa vuxenprofiler ännu. De kommer att hanteras här i Den på webben.',
      tv: 'Namnbyte, borttagning och skapande av vuxenprofiler är inte tillgängliga på den här TV:n. De kommer att hanteras i Den på webben.',
      tizen3:
        'Den här TV:n är endast för visning. Profiladministration är inte tillgänglig på den här TV:n.',
    },
  ] as const;

  for (const expected of cases) {
    await setInterfaceLanguage(expected.language);
    expect(
      i18n.phrase(
        'Rename, delete, and Adult profile creation are not available yet. They will be managed here in Den on the web.',
      ),
    ).toBe(expected.browser);
    expect(
      i18n.phrase(
        'Rename, delete, and Adult profile creation are not available on this TV. They will be managed in Den on the web.',
      ),
    ).toBe(expected.tv);
    expect(
      i18n.phrase('This TV is viewer-only. Profile administration is not available on this TV.'),
    ).toBe(expected.tizen3);
  }
});

it('localizes the reduced-TV download management handoff', async () => {
  const cases = [
    {
      language: 'en',
      title: 'Manage downloads in a supported browser',
      route: 'On a phone or computer linked to this household, open Den › Downloads.',
      cancelFailure: 'Couldn’t cancel that download. Try again.',
    },
    {
      language: 'es',
      title: 'Administrar descargas en un navegador compatible',
      route: 'En un teléfono u ordenador vinculado a este hogar, abre Den › Descargas.',
      cancelFailure: 'No se pudo cancelar la descarga. Inténtalo de nuevo.',
    },
    {
      language: 'sv',
      title: 'Hantera hämtningar i en webbläsare som stöds',
      route: 'Öppna Den › Hämtningar på en telefon eller dator som är länkad till hushållet.',
      cancelFailure: 'Hämtningen kunde inte avbrytas. Försök igen.',
    },
  ] as const;

  for (const expected of cases) {
    await setInterfaceLanguage(expected.language);
    expect(i18n.phrase('Manage downloads in a supported browser')).toBe(expected.title);
    expect(
      i18n.phrase('On a phone or computer linked to this household, open Den › Downloads.'),
    ).toBe(expected.route);
    expect(i18n.phrase('Couldn’t cancel that download. Try again.')).toBe(expected.cancelFailure);
  }
});

it('localizes a saved-language presentation failure without claiming the write failed', async () => {
  const cases = [
    ['en', 'Saved, but not shown.'],
    ['es', 'Guardado, no aplicado.'],
    ['sv', 'Sparat, visas inte.'],
  ] as const;

  for (const [language, message] of cases) {
    await setInterfaceLanguage(language);
    expect(i18n.phrase('Saved, but not shown.')).toBe(message);
  }
});

it('localizes every person filmography role heading', async () => {
  const title = (id: number) => ({ id, media_type: 'movie', title: `Movie ${id}` });
  const labels = groupFilmographyByRole(
    parseFilmography({
      cast: [title(1)],
      crew: [
        { ...title(2), department: 'Directing', job: 'Director' },
        { ...title(3), department: 'Writing', job: 'Writer' },
        { ...title(4), department: 'Writing', job: 'Screenplay' },
        { ...title(5), department: 'Production', job: 'Producer' },
        { ...title(6), department: 'Sound' },
      ],
    }),
  ).map((group) => group.label);
  expect(labels).toEqual(['Actor', 'Director', 'Writer', 'Screenwriter', 'Producer', 'Crew']);

  const expected = {
    en: labels,
    es: ['Interpretación', 'Dirección', 'Escritura', 'Guion', 'Producción', 'Equipo técnico'],
    sv: [
      'Skådespelare',
      'Regissör',
      'Författare',
      'Manusförfattare',
      'Producent',
      'Produktionsteam',
    ],
  } as const;
  for (const language of ['en', 'es', 'sv'] as const) {
    await setInterfaceLanguage(language);
    expect(labels.map((label) => i18n.phrase(label))).toEqual(expected[language]);
  }
});
