import type { ServicePick } from './prefs';

/** The six US services a visitor sees, resolved against TMDB's current directory before display. */
export const GUEST_PICKS: readonly ServicePick[] = [
  { id: 8, country: 'US' },
  { id: 1899, country: 'US' },
  { id: 15, country: 'US' },
  { id: 337, country: 'US' },
  { id: 350, country: 'US' },
  { id: 531, country: 'US' },
];
