# Continue Watching second-tap investigation

Tracks [#372](https://github.com/oxyc/den-edge/issues/372).

Production `0.264.36` still cancels a Continue Watching tap after this exact route lifecycle:

1. hard-refresh Home;
2. tap a Continue Watching card (works);
3. click the Den logo to return to the retained Home page;
4. tap a Continue Watching card again.

The URL remains `/` and the row disappears. Scrolling can restore it. This proves the remaining bug is not the
Verano/TMDB failure and is not covered by the fresh-page observer tests added in #369/#371.

The next regression must exercise the real retained-route shell and Den-logo navigation. Before changing behavior,
it should record the second gesture's pointerdown, pointerup and click, the anchor's connectivity, RoutePage active
state, and the WindowedPosterRow observer/materialization transition. A fix should follow that evidence rather than
adding another timing allowance.
