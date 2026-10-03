// A title's address, handed to the system share sheet where there is one, or copied to the clipboard where
// there isn't (most desktop browsers) — the one fallback, used by `TitleActions`' Share pill and the poster
// menu's Share item, so the two can't drift apart.

export type ShareResult = 'shared' | 'dismissed' | 'copied' | 'failed';

export async function shareOrCopy(target: { title: string; url: string }): Promise<ShareResult> {
  if (navigator.share) {
    try {
      await navigator.share(target);
      return 'shared';
    } catch {
      // Dismissing the sheet rejects, and is a choice rather than a failure worth reporting.
      return 'dismissed';
    }
  }
  try {
    await navigator.clipboard.writeText(target.url);
    return 'copied';
  } catch {
    return 'failed';
  }
}
