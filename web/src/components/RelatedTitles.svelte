<!-- The rows under a title's cast: its franchise, other versions of its story, More like this and its strongest
     mood, what its director, creator, writer and leads have done, its studio and network, its country or language,
     and You might also like. A row shows its heading as soon as it is known, and goes on loading as it is scrolled
     to its end (`BrowseRow`). -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { TitleDetail } from '../lib/detail';
  import type { IconicStudio } from '../lib/iconicStudios';
  import { titleKey, type Title } from '../lib/library';
  import {
    authorRow,
    countryRow,
    firstScreen,
    franchiseRow,
    homeCountry,
    languageRow,
    moodRow,
    moreLikeThisRow,
    personRow,
    personRows,
    producerRows,
    studioRow,
    themeRows,
    versionsRow,
    withPosters,
  } from '../lib/relatedRows';
  import { NO_FACTS, type TitleFacts } from '../lib/titleFacts';
  import { SvelteSet } from 'svelte/reactivity';

  const regions = new Intl.DisplayNames(['en'], { type: 'region' });
  import BrowseRow from './BrowseRow.svelte';

  let {
    detail,
    tmdbKey,
    atlas = null,
    studios,
    facts,
    active,
    shown,
  }: {
    detail: TitleDetail;
    tmdbKey: string;
    /** Where this page reaches atlas, for the titles its index finds closest; null where it can't. */
    atlas?: string | null;
    /**
     * Curated studios credited on this title, each with its own row, and atlas's facts about it — its moods, networks
     * and companies (`fetchTitleFacts`). Either is undefined while it is asked for, and the rows wait for both: a row
     * they name would otherwise join mid-page.
     */
    studios: IconicStudio[] | undefined;
    facts: TitleFacts | undefined;
    active: boolean;
    shown: (t: Title) => boolean;
  } = $props();

  /** You might also like's row id (`moreLikeThisRow`). */
  const SUGGESTED = 'you-might-also-like';
  /** Each shown row with its build: a rebuilt row keeps its id, and must still start its own loader afresh. */
  let rows = $state<{ build: number; row: RowDef }[]>([]);
  /** The title `rows` were built for, and how many builds there have been. Not reactive: the effect only reads them. */
  let rowsFor = '';
  let builds = 0;

  // The rows are built as soon as the title is, and each loads its first page when the browser is next idle
  // (`BrowseRow`), so they are usually full before they are scrolled to. For a title's first build, every row it
  // is known to have shows its heading and card-sized placeholders at once and loads itself, hiding if it turns
  // out empty; only the franchise, other-versions and You might also like rows, which are not known to exist until
  // they are looked up, join once they have something to show.
  // A row remembers what it has loaded, so an atlas that answers late builds them afresh — and then the rows already
  // shown stay until the rebuilt ones have their first page, rather than falling back to placeholders.
  $effect(() => {
    // Held for atlas's studios and facts, which name the studio, mood and network rows: a title's rows are built
    // once, all together.
    const [curated, asked] = [studios, facts];
    if (atlas && (!curated || !asked)) return;
    const known = asked ?? NO_FACTS;
    const credited = curated ?? [];
    const options = { key: tmdbKey };
    const self = detail.title;
    const key = titleKey(self);
    const rebuild = key === rowsFor;
    rowsFor = key;
    const originalLanguage = detail.title.originalLanguage;
    const regionalLanguage =
      originalLanguage && originalLanguage !== 'en'
        ? detail.languages.find((language) => language.id === originalLanguage)
        : undefined;
    // "More from Spain" rather than "More in Spanish", which is Spain, Mexico and Argentina together: the first of its
    // countries where its language is at home (`homeCountry`), atlas's (Wikidata's countries of origin) before TMDB's,
    // which names Pan's Labyrinth Mexican. Where none is, its language's row.
    const countryId =
      regionalLanguage &&
      homeCountry(regionalLanguage.id, [...known.countries, ...detail.countries.map((c) => c.id)]);
    const regionalCountry = countryId
      ? (detail.countries.find((c) => c.id === countryId)?.name ??
        regions.of(countryId) ??
        countryId)
      : undefined;
    const regional =
      !atlas || !regionalLanguage
        ? null
        : countryId && regionalCountry
          ? withPosters(
              countryRow(
                { id: countryId, name: regionalCountry },
                regionalLanguage.id,
                self,
                atlas,
              ),
              options,
            )
          : withPosters(languageRow(regionalLanguage, self, atlas), options);
    let live = true;
    // Every title the rows above have shown, so You might also like, the last row, offers none of them again.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read by loaders only, never rendered.
    const onPage = new Set<string>([titleKey(self)]);
    // The same, as it grows: a row above that loads after You might also like drops its titles from that row then.
    const above = new SvelteSet<string>();
    const noted = (row: RowDef): RowDef => ({
      ...row,
      load: async (page) => {
        const titles = await row.load(page);
        for (const title of titles) {
          onPage.add(titleKey(title));
          above.add(titleKey(title));
        }
        return titles;
      },
    });
    // Known to exist once atlas (or TMDB's collection) names its members, so it joins then with placeholders
    // rather than after every member's poster is drawn — for a franchise atlas sends no posters for, that
    // is one TMDB request per member.
    const franchise = franchiseRow(detail.collection, self, atlas, options).then(
      (row) => row && noted(row),
    );
    const versions = versionsRow(self, atlas, franchise, options).then((row) =>
      row ? firstScreen(noted(row), shown) : null,
    );
    const author = atlas ? authorRow(known, self, atlas) : null;
    // Closest first: what is like this title, then what else came from its source author's books, the people who
    // made it, then the same of its strongest mood, its
    // studio, network and country or language, which say less about this title in particular, and last the looser
    // suggestions. atlas's filter sends no posters, so those rows draw their own (`withPosters`).
    // More like this and the mood row share what they have offered, so a title appears in only one of them.
    const suggested = new Set<string>();
    const similar = moreLikeThisRow(detail, atlas, {
      ...options,
      mixed: true,
      similarLimit: 200,
      seen: suggested,
    });
    let similarIn = () => {};
    const similarLoaded = new Promise<void>((resolve) => (similarIn = resolve));
    const mood = atlas
      ? moodRow(known.moods, self, atlas, { seen: suggested, after: similarLoaded })
      : null;
    const defined: RowDef[] = [
      // Films and series together; curated primary members have their own row and atlas excludes them here.
      // Ask for atlas's whole ranked row: the loader pages this answer into screenfuls before it falls through to
      // the broader plot-neighbour and TMDB sources.
      { ...similar, load: (page: number) => similar.load(page).finally(similarIn) },
      // Every adaptation of the same author's work, the franchise's and other versions' included: the whole list is
      // what someone asking "what else came from their books" wants.
      ...(author ? [withPosters(author, options)] : []),
      ...personRows(detail).map((r) => personRow(r.person, r.department, self, options, r.before)),
      ...(mood ? [withPosters(mood, options)] : []),
      ...(atlas
        ? [
            ...themeRows(known, self, atlas, regionalCountry),
            ...credited.map((studio) => studioRow(studio, self, atlas)),
            ...producerRows(known, credited, self, atlas),
          ].map((row) => withPosters(row, options))
        : []),
      ...(regional ? [regional] : []),
    ].map(noted);
    // atlas's structural-affinity order alone: the wider sources are More like this's. It is asked once More like
    // this has its first page, and skips every title the rows above have shown (`onPage`) — so like the franchise
    // it joins only with something to show, and last, where arriving late grows the page below the viewer rather
    // than moving it. A row above that loads later (other versions) drops its titles from it then.
    const affinity = atlas
      ? similarLoaded.then(() => {
          const row = moreLikeThisRow(detail, atlas, {
            ...options,
            mixed: true,
            similarLimit: 200,
            affinity: true,
            fallback: false,
            seen: onPage,
          });
          return firstScreen({ ...row, filter: (title) => !above.has(titleKey(title)) }, shown);
        })
      : Promise.resolve(null);
    const build = ++builds;
    if (rebuild) {
      void Promise.all([
        franchise,
        versions,
        ...defined.map((row) => firstScreen(row, shown)),
        affinity,
      ]).then((found) => {
        if (!live) return;
        const next = found
          .filter((row): row is RowDef => row !== null)
          .map((row) => ({ build, row }));
        // A rebuild with no atlas has none to suggest: the suggestions already shown for this title stay, rather
        // than shrinking the page under a viewer at its end.
        const kept = found.at(-1) ? undefined : rows.find(({ row }) => row.id === SUGGESTED);
        rows = kept ? [...next, kept] : next;
      });
    } else {
      rows = defined.map((row) => ({ build, row }));
      void franchise.then(async (row) => {
        if (live && row) rows = [{ build, row }, ...rows];
        // Other versions sit straight under the franchise, which they are never part of.
        const other = await versions;
        if (!live || !other) return;
        const at = row
          ? rows.findIndex((entry) => entry.build === build && entry.row.id === row.id) + 1
          : 0;
        rows = [...rows.slice(0, at), { build, row: other }, ...rows.slice(at)];
      });
      void affinity.then((row) => {
        if (live && row) rows = [...rows, { build, row }];
      });
    }
    return () => {
      live = false;
    };
  });
</script>

<div aria-hidden={!active}>
  {#each rows as { build, row } (`${build}:${row.id}`)}
    <BrowseRow {row} {shown} />
  {/each}
</div>
