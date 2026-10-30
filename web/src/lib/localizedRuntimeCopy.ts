/**
 * A poster caption mixes provider/runtime data with a few build-authored English units. Keep the
 * data byte-for-byte while translating the authored segments independently.
 */
export function localizePosterCaption(
  value: string | undefined,
  phrase: (english: string) => string,
): string | undefined {
  return value
    ?.split(' · ')
    .map((part) => {
      const counted = /^(\d+) (season|seasons|episode|episodes)$/.exec(part);
      return counted ? `${counted[1]} ${phrase(counted[2]!)}` : phrase(part);
    })
    .join(' · ');
}
