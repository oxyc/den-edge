# Detail screens: Apple TV reference and regression coverage

The web implementation follows `App/Den/Components/DetailHeader.swift`,
`App/Den/Screens/DetailView.swift`, `DetailSeasonViews.swift`, `SeriesEpisodesView.swift`,
and `PersonView.swift` in the Den app. Native episodes are rows within series details;
there is no separate native episode-details route to reproduce.

| Surface               | Web behavior                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Movie / series header | Rectangular poster, ratings and votes, dates / series year range, runtime, certification, regional streaming providers with JustWatch attribution, genres, overview, language, country, studios / networks, budget / revenue, awards |
| Tablet and desktop    | Large poster beside the metadata and description, background trailer, bordered controls, separate reaction buttons                                                                                                                   |
| Mobile portrait       | Static trailer area above poster and metadata; description and production facts below; Trailer remains with Watchlist / Seen / opinion controls                                                                                      |
| Playback              | Continue / next episode derived from reset-aware progress; the main action and episode actions send exact coordinates, including Play on TV                                                                                          |
| Episodes              | Visible 16:9 stills at every width, episode numbers, runtime, air dates, upcoming dates instead of spoilers, watched / partial progress, row playback and an options menu                                                            |
| Seasons               | Regular-season totals and aired watch counts, latest played season initially selected, cached season lists, guarded asynchronous selection, keyboard tabs, download-season action                                                    |
| Sources               | Per-movie or per-episode source list, supplied quality / language / size / readiness metadata, release selection for browser playback, download initiation and status                                                                |
| Downloads             | Queue once, then read-only probes; never follow media redirects into JS; active jobs outlive SPA navigation; season passes exclude future episodes and unseeded releases                                                             |
| Related titles        | Cast and directors, collection, recommendations, director filmography and starring rows                                                                                                                                              |
| Actor                 | 2:3 portrait, biography and expansion, all credits by department, known department initially selected, newest first, per-department deduplication and incremental poster rendering                                                   |
| Content warnings      | Existing TV opt-in categories and user key, confirmed non-spoiler topics only; missing data produces no claim                                                                                                                        |

`detailPresentation.test.ts`, `titleSources.test.ts`, `seasonDownloads.test.ts` and
`contentWarnings.test.ts` cover the shared data and action decisions. `detail-parity.spec.mjs`
exercises the real components and router at phone, tablet and desktop widths, delayed ratings,
season request races, actor department / biography / scroll restoration, episode actions,
source coordinates and queue-vs-probe behavior. The existing navigation, actor snapshot,
billboard, trailer and layout suites remain part of the full run.

Detail-page trailers start at **0 seconds**. Billboard / carousel preview policy is separate.
The detail player uses the browser's native poster-to-video handoff, rather than keeping an
advancing video transparent. Reel metadata is revalidated and invalid or portrait candidates
fall through to the next candidate. The trailer tests use real decodable video data, including
wide video, failed candidates, blocked autoplay and delayed network responses.

Browser automation uses isolated Chromium contexts. A physical iPhone running Brave still
needs a manual check for WebKit's autoplay and browser-owned gestures. Automated source and
download tests mock the service; they do not queue real media as a test side effect.
