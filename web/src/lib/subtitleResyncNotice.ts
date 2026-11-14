export type SubtitleResyncNotice = false | number | null;

/** A terminal result is present even when its semantic payload is false or numeric zero. */
export function hasSubtitleResyncNotice(
  notice: SubtitleResyncNotice,
): notice is Exclude<SubtitleResyncNotice, null> {
  return notice !== null;
}

/** Render retained result state through the live profile catalog each time the notice is read. */
export function subtitleResyncNoticeText(
  notice: Exclude<SubtitleResyncNotice, null>,
  phrase: (english: string) => string,
  formattedOffset: (offset: number) => string,
): string {
  return notice === false
    ? phrase('Subtitles could not be re-synced. Your current timing is unchanged.')
    : `${phrase('Subtitles re-synced')} · ${formattedOffset(notice)}`;
}

/** Start a fresh expiry only while the caller's explicit presence predicate is true. */
export function scheduleNoticeExpiry(
  shown: boolean,
  clear: () => void,
  ms: number,
): (() => void) | undefined {
  if (!shown) return undefined;
  const timer = setTimeout(clear, ms);
  return () => clearTimeout(timer);
}
