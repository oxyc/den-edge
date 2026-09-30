// People: the people credited on the titles a selection matches, narrowed by what Wikidata says about them — the
// credit (actor, director, screenwriter, creator), gender, birth years, nationality and occupation — from
// den-atlas's people routes (`filterRoutes.ts`). The title facets are Explore's own chips; the person traits are
// picked as `<trait>-<value>` ids (`role-director`, `gender-Q6581072`, `born-1976-1996`), the
// address's `t=`.

import { filterItems, groupItems } from './facetCounts';
import { browseChips, exploreChips, FOR_YOU, type Chip, type ChipGroup } from './explore';
import { TRAIT_KINDS, type FilterItem, type PeopleCounts } from './filterRoutes';
import type { ExploreType } from './library';
import { FACET, fansOf, likeOf, type Explore, type PeopleView } from './route';

/** The traits, in the order the rail lists them. */
export const TRAITS = ['role', 'gender', 'born', 'citizenship', 'occupation'] as const;

/** atlas's credits, in its order, as the rail names them. */
const ROLES: Record<string, string> = {
  cast: 'Actors',
  director: 'Directors',
  writer: 'Screenwriters',
  creator: 'Creators',
};

/** Occupations already expressed more accurately by the credit Role section. */
const ROLE_OCCUPATIONS = new Set([
  'Q33999', // actor
  'Q10800557', // film actor
  'Q10798782', // television actor
  'Q2259451', // stage actor
  'Q2405480', // voice actor
  'Q11481802', // dub actor
  'Q3455803', // director
  'Q2526255', // film director
  'Q2059704', // television director
  'Q3387717', // theatre director
  'Q28389', // screenwriter
  'Q69423232', // film screenwriter
]);

/**
 * A birth-year range in an address, where an id may not end on a dash: `born-1976-1996`, and an open end as
 * `born-from-1976` or `born-to-1996`. atlas writes them `1976-1996`, `1976-`, `-1996`.
 */
const bornValue = (value: string) =>
  value.replace(/^from-(\d+)$/, '$1-').replace(/^to-(\d+)$/, '-$1');
const bornPart = (value: string) =>
  value.replace(/^(\d+)-$/, 'from-$1').replace(/^-(\d+)$/, 'to-$1');

/** A trait pick as atlas's item: `role-director` is `role:director`; undefined for anything else. */
export function traitItem(id: string): FilterItem | undefined {
  const at = id.indexOf('-');
  const [kind, raw] = [id.slice(0, at), id.slice(at + 1)];
  const value = kind === 'born' ? bornValue(raw) : raw;
  if (kind === 'born' && !value.includes('-')) return undefined;
  return at > 0 && value && TRAIT_KINDS[kind] ? { kind, id: value } : undefined;
}

/** A birth-year range's pick, either end left out (undefined), or undefined for no range at all. */
export const bornRangeId = (from?: number, to?: number): string | undefined =>
  from === undefined && to === undefined
    ? undefined
    : `born-${bornPart(`${from ?? ''}-${to ?? ''}`)}`;

/** The birth-year range among the trait picks, its ends as years; undefined for none. */
export function bornRangeOf(traits: readonly string[]): { from?: number; to?: number } | undefined {
  for (const id of traits) {
    const item = traitItem(id);
    if (item?.kind !== 'born' || !item.id.includes('-')) continue;
    const [from, to] = item.id.split('-').map((year) => (year ? Number(year) : undefined));
    return { from, to };
  }
  return undefined;
}

/** A range of birth years: it stands alone, never in an OR group nor beside another birth pick. */
const bornRange = (id: string) => {
  const item = traitItem(id);
  return item?.kind === 'born' && item.id.includes('-');
};

/**
 * The trait picks as atlas's `traits`: a trait's values one OR group (American or British; a director or a writer),
 * but a range of birth years, which stands alone.
 */
export const traitItems = (ids: readonly string[]): FilterItem[] =>
  groupItems(
    ids.flatMap((id) => {
      const item = traitItem(id);
      return item ? [{ items: [item], kind: bornRange(id) ? undefined : item.kind }] : [];
    }),
  );

const sameKind = (a: string, b: string) => traitItem(a)?.kind === traitItem(b)?.kind;

/**
 * The trait picks once `id` is picked: one already in comes out; any other goes in last, joining its trait's other
 * values as either-or. A range of birth years stands alone: it takes the place of any other birth pick, and one takes
 * its place.
 */
export function pickTrait(traits: readonly string[], id: string): string[] {
  if (traits.includes(id)) return traits.filter((x) => x !== id);
  if (!traitItem(id)) return [...traits];
  const gives = (x: string) => sameKind(x, id) && (bornRange(id) || bornRange(x));
  return [...traits.filter((x) => !gives(x)), id];
}

/** Whether a trait option is worth offering: not picked, and no second born value beside a birth-year range. */
export const traitOffered = (traits: readonly string[], id: string): boolean =>
  !!traitItem(id) && !traits.includes(id) && !traits.some((x) => sameKind(x, id) && bornRange(x));

/**
 * Whether a trait option leaves no one beside the selection, by atlas's counts: none in a trait they list completely.
 * A trait listed only in part (its top values) judges nothing, and nor does a trait already picked: another of its
 * values joins the pick as either-or, which can only add people.
 */
export function traitEmpty(
  id: string,
  counts: PeopleCounts,
  traits: readonly string[] = [],
): boolean {
  const item = traitItem(id);
  const answer = item ? counts.traits[item.kind] : undefined;
  if (!item || traits.some((x) => sameKind(x, id))) return false;
  return !!answer?.complete && !(answer.values?.[item.id] ?? 0);
}

/** A birth-year range's words: "Born 1976–1996", "Born 1976 or later", "Born 1996 or earlier". */
function bornLabel(range: string): string {
  const [from, to] = range.split('-');
  if (from && to) return `Born ${from}–${to}`;
  return from ? `Born ${from} or later` : `Born ${to} or earlier`;
}

/**
 * A trait value's words: a role's plural, a birth-year range, or a Wikidata item by atlas's label.
 */
function traitLabel(kind: string, value: string, labels?: Record<string, string>): string {
  if (kind === 'role') return ROLES[value] ?? value;
  if (kind === 'born') return bornLabel(value);
  const label = labels?.[value];
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : value;
}

/**
 * The trait options atlas's counts list beside the selection, and the picked ones: each has people there, since
 * atlas lists no value with none. Roles are in atlas's order; the rest are ordered by people, label, then id.
 */
export function traitChips(counts: PeopleCounts): Chip[] {
  return TRAITS.flatMap((kind) => {
    const answer = counts.traits[kind];
    if (!answer) return [];
    if (kind === 'born')
      return (answer.selected ?? []).flatMap(
        (value) => traitChip(kind, value, answer.labels) ?? [],
      );
    const values = Object.entries(answer.values ?? {}).filter(
      ([value]) => kind !== 'occupation' || !ROLE_OCCUPATIONS.has(value),
    );
    if (kind === 'role') values.sort(([a], [b]) => roleRank(a) - roleRank(b));
    else
      values.sort(
        ([a, an], [b, bn]) =>
          bn - an ||
          traitLabel(kind, a, answer.labels).localeCompare(traitLabel(kind, b, answer.labels)) ||
          a.localeCompare(b),
      );
    const ids = [
      ...new Set([
        ...values.map(([value]) => value),
        ...(answer.selected ?? []).filter(
          (value) => kind !== 'occupation' || !ROLE_OCCUPATIONS.has(value),
        ),
      ]),
    ];
    return ids.flatMap((value) => traitChip(kind, value, answer.labels) ?? []);
  });
}

/** A trait value as a chip, named from `labels` where it is a Wikidata item; undefined for an id no address holds. */
export function traitChip(
  kind: string,
  value: string,
  labels?: Record<string, string>,
): Chip | undefined {
  const id = `${kind}-${kind === 'born' ? bornPart(value) : value}`;
  return FACET.test(id)
    ? { id, label: traitLabel(kind, value, labels), group: kind as ChipGroup }
    : undefined;
}
const roleRank = (role: string) => {
  const at = Object.keys(ROLES).indexOf(role);
  return at < 0 ? Infinity : at;
};

/** A trait pick before atlas's counts have named it: a role or range by its words, an item as "Nationality…". */
export function pendingTraitChip(id: string): Chip | undefined {
  const item = traitItem(id);
  if (!item) return undefined;
  const group = item.kind as ChipGroup;
  if (item.kind === 'role' || item.kind === 'born')
    return { id, label: traitLabel(item.kind, item.id), group };
  const word = { gender: 'Gender', citizenship: 'Nationality', occupation: 'Occupation' }[
    item.kind
  ];
  return { id, label: `${word}…`, group };
}

/**
 * Explore's chips that can scope People's credits: every one atlas's filter can take (`filterItems`) — not For You,
 * which is a person's own taste, nor a recipe atlas has no form of — and not the rating floors, which are TMDB's.
 */
export function titleChips(type: ExploreType): Chip[] {
  return exploreChips(type, { atlas: true }).filter(
    (chip) =>
      chip.group !== 'for-you' &&
      chip.group !== 'rating' &&
      filterItems([chip.id], type) !== undefined,
  );
}

/**
 * What Explore's tab link to People carries: the type, and the title facets atlas's people filter can read. For You
 * (one's own taste), a rating floor (TMDB's), a "Like" (one title's neighbours) and a "Fans of" (one title's You
 * Might Also Like) scope no credits, so they stay behind, as does a typed query.
 */
export function peopleFromExplore({ type, chips = [] }: Explore): PeopleView {
  const kept = chips.filter(
    (id) =>
      id !== FOR_YOU &&
      !id.startsWith('rating-') &&
      !likeOf(id) &&
      !fansOf(id) &&
      filterItems([id], type ?? 'all') !== undefined,
  );
  return { ...(type ? { type } : {}), ...(kept.length ? { chips: kept } : {}) };
}

export { exploreFromPeople } from './route';

/**
 * What the bar's search field offers on People, as Explore's Browse row does: the roles and genders the text names,
 * then the nationalities and occupations atlas found by it (`found`), then the title facets it names. Each once,
 * and only those `offered` (not picked, and able to stand beside the picks).
 */
export function peopleSuggestions(
  query: string,
  listed: Chip[],
  found: Chip[],
  offered: (id: string) => boolean,
): Chip[] {
  const matched = browseChips(query, listed);
  const trait = (chip: Chip) => traitItem(chip.id) !== undefined;
  return [...matched.filter(trait), ...found, ...matched.filter((chip) => !trait(chip))].filter(
    (chip, at, all) => offered(chip.id) && all.findIndex((other) => other.id === chip.id) === at,
  );
}

/** The title facets as atlas's `sel`, leaving out any it can't read; a kind's values one OR group, as on Explore. */
export const titleItems = (chips: readonly string[], type: ExploreType): FilterItem[] =>
  filterItems(
    chips.filter((id) => filterItems([id], type) !== undefined),
    type,
  ) ?? [];

/** People's orders, as the sort names them. */
export const ORDERS: { value: string; label: string }[] = [
  { value: 'prominence', label: 'Most prominent' },
  { value: 'credits', label: 'Most credits' },
  { value: 'name', label: 'Name' },
  { value: 'born_desc', label: 'Youngest' },
  { value: 'born_asc', label: 'Oldest' },
];

/** The rail's sections: the person traits first, then the title facets that scope which credits count. */
export const SECTIONS: [ChipGroup, string][] = [
  ['role', 'Role'],
  ['gender', 'Gender'],
  ['citizenship', 'Nationality'],
  ['occupation', 'Also works as'],
  ['genre', 'In genres'],
  ['mood', 'In moods'],
  ['recipe', 'In subgenres'],
  ['decade', 'Titles from'],
  ['language', 'Language'],
  ['country', 'Country'],
  ['region', 'Region'],
  ['company', 'Studio'],
  ['network', 'Network'],
  ['subject', 'Titles about'],
  ['place', 'Titles set in'],
  ['format', 'Title type'],
  ['source', 'Based on'],
  ['author', 'Adapted from'],
  ['technique', 'Made with'],
  ['audience', 'Audience'],
  ['critique', 'Critiques'],
  ['runtime', 'Runtime'],
  ['animated', 'Animation'],
];
