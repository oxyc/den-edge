// The fixed lists the TV's settings screens offer, copied from DenKit so both pick from the same values: the codes and
// names are what the library stores and matches on (`den.excludedLanguages`, `den.excludedGenreIDs`,
// `den.shownWarningCategories`, …), so a list that drifts from the TV's writes values the TV doesn't know.

/** `LanguageCatalog.common`: ISO 639-1 codes, the ones TMDB returns in `original_language`. */
export const LANGUAGES: readonly { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'ar', name: 'Arabic' },
  { code: 'tr', name: 'Turkish' },
  { code: 'th', name: 'Thai' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'nb', name: 'Norwegian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'id', name: 'Indonesian' },
];

export const languageName = (code: string | undefined): string | undefined =>
  LANGUAGES.find((l) => l.code === code)?.name;

/** `GenreCatalog`: TMDB's genre ids. Some ids are shared by both lists, so hiding one hides it in the other. */
export const MOVIE_GENRES: ReadonlyMap<number, string> = new Map([
  [28, 'Action'],
  [12, 'Adventure'],
  [16, 'Animation'],
  [35, 'Comedy'],
  [80, 'Crime'],
  [99, 'Documentary'],
  [18, 'Drama'],
  [10751, 'Family'],
  [14, 'Fantasy'],
  [36, 'History'],
  [27, 'Horror'],
  [10402, 'Music'],
  [9648, 'Mystery'],
  [10749, 'Romance'],
  [878, 'Science Fiction'],
  [10770, 'TV Movie'],
  [53, 'Thriller'],
  [10752, 'War'],
  [37, 'Western'],
]);

export const TV_GENRES: ReadonlyMap<number, string> = new Map([
  [10759, 'Action & Adventure'],
  [16, 'Animation'],
  [35, 'Comedy'],
  [80, 'Crime'],
  [99, 'Documentary'],
  [18, 'Drama'],
  [10751, 'Family'],
  [10762, 'Kids'],
  [9648, 'Mystery'],
  [10763, 'News'],
  [10764, 'Reality'],
  [10765, 'Sci-Fi & Fantasy'],
  [10766, 'Soap'],
  [10767, 'Talk'],
  [10768, 'War & Politics'],
  [37, 'Western'],
]);

/** A genre row as Hidden Genres lists it: a TMDB genre, or the synthetic Anime (Animation in Japanese). */
export type GenreEntry =
  { kind: 'genre'; id: number; name: string } | { kind: 'anime'; name: 'Anime' };

/** One list's rows, A–Z, with Anime beside Animation where the list has Animation (`HiddenGenresView.entries`). */
export function genreEntries(genres: ReadonlyMap<number, string>): GenreEntry[] {
  const entries: GenreEntry[] = [...genres].map(([id, name]) => ({ kind: 'genre', id, name }));
  if (genres.has(16)) entries.push({ kind: 'anime', name: 'Anime' });
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `ContentWarningCatalog.groups`: doesthedogdie's category names, matched by name. */
export const WARNING_GROUPS: readonly { name: string; categories: readonly string[] }[] = [
  {
    name: 'Violence',
    categories: [
      'Violence',
      'Large-scale Violence',
      'Assault',
      'Abuse',
      'Natural Disasters',
      'Vehicular',
    ],
  },
  { name: 'Sex', categories: ['Sex', 'Sexual Assault'] },
  { name: 'Death & Loss', categories: ['Death', 'Loss', 'Family', 'Abandonment'] },
  { name: 'Children', categories: ['Children', 'Pregnancy'] },
  { name: 'Animals', categories: ['Animal Death', 'Animal Distress', 'Animal Phobia'] },
  {
    name: 'Mental Health & Addiction',
    categories: [
      'Mental Health',
      'Self Harm',
      'Addiction',
      'Drugs/Alcohol',
      'Paranoia',
      'Relationships',
    ],
  },
  {
    name: 'Identity & Society',
    categories: [
      'LGBTQ+',
      'Race',
      'Religious',
      'Sexism',
      'Prejudice',
      'Disability',
      'Law Enforcement',
      'Social',
    ],
  },
  { name: 'Medical', categories: ['Medical', 'Sickness'] },
  { name: 'Fear & Disgust', categories: ['Fear', 'Gross', 'Noxious', 'Creepy Crawly', 'Spoiler'] },
  { name: 'Body', categories: ['Whole Body', 'Head', 'Neck', 'Appendages'] },
];

/** `MinReleaseYearView.options`: the floor year, newest first; undefined is no floor. */
export const MIN_YEARS: readonly { year?: number; label: string }[] = [
  { label: 'Any year' },
  { year: 2020, label: '2020s & newer' },
  { year: 2010, label: '2010s & newer' },
  { year: 2000, label: '2000s & newer' },
  { year: 1990, label: '1990s & newer' },
  { year: 1980, label: '1980s & newer' },
];

/** `SubtitlesPerLanguageView`: 0 keeps every track. */
export const SUBTITLES_PER_LANGUAGE: readonly { count: number; label: string }[] = [
  { count: 1, label: '1' },
  { count: 3, label: '3' },
  { count: 5, label: '5' },
  { count: 0, label: 'All' },
];

/** `RatingSource`, in the order the TV lists them. */
export const RATING_SOURCES: readonly { id: string; name: string }[] = [
  { id: 'imdb', name: 'IMDb' },
  { id: 'tmdb', name: 'TMDB' },
  { id: 'rottenTomatoes', name: 'Rotten Tomatoes' },
  { id: 'metacritic', name: 'Metacritic' },
];
