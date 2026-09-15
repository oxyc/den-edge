# den-edge — how to work in this repo

## What the trailers have to do

**The best picture the browser can play, as soon as possible, in every browser.** Both halves, not one
traded for the other, and no browser left as the lowest common denominator.

What follows from that:

- **A visibly poor picture is worse than a short wait.** The still artwork is already underneath every
  trailer. Keeping it there a moment longer costs nothing; opening at 144p and climbing for four seconds
  is seen every time and looks broken.
- **Quality is chosen per browser.** Which player, which ladder and which codecs differ between WebKit,
  Chromium and whatever a phone offers. The answer is to serve each one what it plays best, not to pick
  something all of them tolerate.
- **The ladder is the first lever, not the last.** A master that never offers a useless rung cannot open
  on one, in any browser and in any player — including the platform players we do not configure.
  den-reel filters and floors its master (`playable`, `native=1`); prefer fixing the ladder there over
  steering a player here.

## Find the cause before writing the fix

**A plausible explanation is not a diagnosis.** Every fix here lands on a box the user then has to test
by hand, on his own hardware, often after clearing a cache. A guess that ships spends his time, not
yours — and if it is wrong it leaves behind code built on a false premise.

So, in order:

1. **Measure on the live page.** Chrome and Safari consoles are available, and the user will run a
   snippet on request. A console experiment costs seconds; a release costs a build, a deploy, a cache
   clear and his attention.
2. **Bisect against a control.** Change one variable at a time and compare with something known to
   work — stock library configuration beside ours, a bare element beside the styled one, one codec
   beside another. A hypothesis never tested against a control is still a hypothesis.
3. **Only then change code**, and say in the commit what was measured, on what, and what it showed.

Worked in practice: a billboard trailer stalling on Safari was blamed in turn on an audio rendition,
`volume`, VP9, and page compositing — four releases, three of them wrong. What found it was running a
stock `new Hls()` next to ours on the same page: ours crawled, stock played. The cause was our own
forced `nextLevel`, and the fix deleted code rather than adding it.

## Prefer deleting the cause to compensating for it

When a workaround and a removal both fix the symptom, remove. Compensating code outlives the browser
bug it was written for, and the next reader cannot tell which is which.

## Never write an unproven mechanism into a comment as fact

Comments here explain why, which makes them the place a wrong theory does the most damage — it reads as
established later. Write what was measured ("itag 616 stalled, currentTime frozen at 6.69s while the
decoder ran at 25x"), not what it is assumed to mean. If the cause is inferred rather than observed,
say so in the comment.

## Releases

- The version in `Cargo.toml` **and** `Cargo.lock`, then a `vX.Y.Z` tag. A red CI leaves a tag that
  builds no image, and `den-update` installs the newest signed image for a unit — so a newer tag whose
  image exists will silently shadow an older one you meant to deploy.
- Run `npm run lint`, `npm test` and `npm run test:e2e` in `web/` locally before tagging. CI runs them
  too, but a failure found after the tag is a wasted release.
- This checkout is shared with other Claude sessions. Commit with an explicit pathspec, never `-a`.
