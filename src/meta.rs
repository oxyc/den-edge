//! What a shared link shows, written into the app's HTML before it leaves here.
//!
//! Den is one page that fills itself in, and the things that build a link preview — Slack, iMessage, WhatsApp,
//! a crawler — run no JavaScript. They read the HTML as it arrives, so every link unfurled as "Den" with a
//! generic picture, whatever the page went on to show. A link to a title should say which title.
//!
//! `index.html` marks the block this replaces (`<!--den:meta-->`), so nothing here parses HTML or guesses at
//! tags: what the build wrote is the fallback, and this swaps the whole block for the page being asked for.
//!
//! What it knows comes from the TMDB proxy's own cache (`tmdb.rs`), so a title already looked at costs a local
//! file read. One that hasn't been costs a short wait, once, and then it is cached for six months like any
//! other answer — and if TMDB is slow or unreachable, the fallback block goes out unchanged.

use crate::AppState;
use axum::http::{header, HeaderMap};
use std::sync::Arc;
use std::time::Duration;

const START: &str = "<!--den:meta-->";
const END: &str = "<!--/den:meta-->";

/// How long a page load will wait on TMDB before going out with the generic block. A cache hit takes none of
/// it; this bounds only the first look at a title, and a reader waiting on a page beats a perfect preview.
const BUDGET: Duration = Duration::from_millis(if cfg!(test) { 300 } else { 3000 });

/// The pages worth describing. Everything else — Home, an unknown path — keeps the fallback block.
enum Page {
    /// A film or a series, by TMDB id.
    Title {
        kind: &'static str,
        id: u32,
    },
    Person {
        id: u32,
    },
    Search {
        query: String,
    },
    Tab {
        name: &'static str,
    },
}

/// The app's own address scheme, as `route.ts` writes it. Read here too, because the shell is served before
/// any of that runs; a path this doesn't recognise simply keeps the fallback.
fn page(path: &str, query: Option<&str>) -> Option<Page> {
    let mut parts = path.split('/').skip(1);
    let id = |segment: Option<&str>| -> Option<u32> {
        let segment = segment?;
        let digits = segment.split('-').next()?;
        digits.parse().ok().filter(|n| *n > 0)
    };
    match parts.next()? {
        "movie" => Some(Page::Title { kind: "video.movie", id: id(parts.next())? }),
        "tv" => Some(Page::Title { kind: "video.tv_show", id: id(parts.next())? }),
        "person" => Some(Page::Person { id: id(parts.next())? }),
        "search" => {
            let asked = query
                .map(|q| {
                    url::form_urlencoded::parse(q.as_bytes())
                        .find(|(name, _)| name == "q")
                        .map(|(_, value)| value.into_owned())
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            Some(Page::Search { query: asked })
        }
        "movies" => Some(Page::Tab { name: "Movies" }),
        "series" => Some(Page::Tab { name: "Series" }),
        "watchlist" => Some(Page::Tab { name: "Watchlist" }),
        "settings" => Some(Page::Tab { name: "Settings" }),
        _ => None,
    }
}

/// This request's own origin. https, because a preview is only ever built for the public name, and most of the
/// things building one refuse a relative image.
fn origin(headers: &HeaderMap) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let host = host.trim();
    let bare = !host.is_empty() && !host.contains(['/', '@', ' ', '"', '<', '>']);
    bare.then(|| format!("https://{host}"))
}

/// Text going into an attribute or an element. A title is somebody else's words: an apostrophe, an ampersand
/// or a stray angle bracket must not be able to end the tag it sits in.
fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// One sentence of somebody's overview, short enough for a card rather than an essay.
fn shortened(text: &str, most: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= most {
        return text.to_owned();
    }
    let cut: String = text.chars().take(most).collect();
    let end = cut.rfind(' ').unwrap_or(cut.len());
    format!("{}…", cut[..end].trim_end_matches([',', '.', ';', ':']))
}

/// TMDB's artwork at the shape a link card wants. A card is 1.91:1, so the backdrop; a title with none falls
/// back to its poster, which is better cropped than absent.
fn artwork(value: &serde_json::Value) -> Option<String> {
    let backdrop = value.get("backdrop_path").and_then(|v| v.as_str());
    let poster = value.get("poster_path").and_then(|v| v.as_str());
    let profile = value.get("profile_path").and_then(|v| v.as_str());
    match (backdrop, poster.or(profile)) {
        (Some(path), _) => Some(format!("https://image.tmdb.org/t/p/w1280{path}")),
        (None, Some(path)) => Some(format!("https://image.tmdb.org/t/p/w780{path}")),
        _ => None,
    }
}

/// The head block for this page, or `None` to leave the fallback alone.
async fn block(state: &Arc<AppState>, path: &str, query: Option<&str>, origin: &str) -> Option<String> {
    let (name, description, image, kind) = match page(path, query)? {
        Page::Title { kind, id } => {
            let asked = if kind == "video.movie" { format!("/3/movie/{id}") } else { format!("/3/tv/{id}") };
            let details = asked_behind(state, asked).await?;
            let name = details
                .get("title")
                .or_else(|| details.get("name"))
                .and_then(|v| v.as_str())
                .filter(|n| !n.trim().is_empty())?
                .to_owned();
            let released = details
                .get("release_date")
                .or_else(|| details.get("first_air_date"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let year = released.get(..4).filter(|y| y.chars().all(|c| c.is_ascii_digit()));
            let overview = details.get("overview").and_then(|v| v.as_str()).unwrap_or("");
            (
                match year {
                    Some(year) => format!("{name} ({year})"),
                    None => name,
                },
                shortened(overview, 200),
                artwork(&details),
                kind,
            )
        }
        Page::Person { id } => {
            let person = asked_behind(state, format!("/3/person/{id}")).await?;
            let name =
                person.get("name").and_then(|v| v.as_str()).filter(|n| !n.trim().is_empty())?.to_owned();
            let known = person.get("known_for_department").and_then(|v| v.as_str()).unwrap_or("");
            let biography = person.get("biography").and_then(|v| v.as_str()).unwrap_or("");
            let description = if biography.trim().is_empty() {
                if known.is_empty() {
                    String::new()
                } else {
                    format!("{known} on Den.")
                }
            } else {
                shortened(biography, 200)
            };
            (name, description, artwork(&person), "profile")
        }
        Page::Search { query } => {
            let asked = query.trim();
            if asked.is_empty() {
                ("Search".to_owned(), "Search Den for movies, series and people.".to_owned(), None, "website")
            } else {
                (format!("Search: {asked}"), format!("What Den found for “{asked}”."), None, "website")
            }
        }
        Page::Tab { name } => (name.to_owned(), format!("{name} in your Den library."), None, "website"),
    };

    // TMDB asks that anything built on their data says so, and a card carrying an overview and a poster is
    // exactly that. It rides in the description because a preview shows no other prose.
    let credit = "This product uses the TMDB API but is not endorsed or certified by TMDB.";
    let described =
        if description.is_empty() { credit.to_owned() } else { format!("{description} — {credit}") };
    let image = image.unwrap_or_else(|| format!("{origin}/og.png"));
    let url = format!("{origin}{path}");
    let (name, described, image, url) = (escaped(&name), escaped(&described), escaped(&image), escaped(&url));
    Some(format!(
        "<title>{name} · Den</title>\
         <meta name=\"description\" content=\"{described}\" />\
         <meta property=\"og:type\" content=\"{kind}\" />\
         <meta property=\"og:site_name\" content=\"Den\" />\
         <meta property=\"og:title\" content=\"{name}\" />\
         <meta property=\"og:description\" content=\"{described}\" />\
         <meta property=\"og:image\" content=\"{image}\" />\
         <meta property=\"og:url\" content=\"{url}\" />\
         <link rel=\"canonical\" href=\"{url}\" />\
         <meta name=\"twitter:card\" content=\"summary_large_image\" />\
         <meta name=\"twitter:title\" content=\"{name}\" />\
         <meta name=\"twitter:description\" content=\"{described}\" />\
         <meta name=\"twitter:image\" content=\"{image}\" />"
    ))
}

/// `tmdb::ask`, in a task of its own. A page gives up waiting after `BUDGET`, and the question used to be dropped
/// with it — after `fetch` had spent a unit of the day's budget, and before the answer was kept — so a title TMDB was
/// slow to answer was paid for again on every preview of it. Now the question runs to the end and keeps its answer,
/// and the next preview of the title is a hit.
async fn asked_behind(state: &Arc<AppState>, path: String) -> Option<serde_json::Value> {
    let state = Arc::clone(state);
    tokio::spawn(async move { crate::tmdb::ask(&state, &path, None).await }).await.ok()?
}

/// The shell with this page's head block in place of the fallback, or `None` to serve it untouched — an
/// unknown path, no marked block, no origin to build absolute URLs from, or TMDB taking too long to be worth
/// a reader's wait.
pub async fn rewrite(
    state: &Arc<AppState>,
    html: &[u8],
    path: &str,
    query: Option<&str>,
    headers: &HeaderMap,
) -> Option<String> {
    let html = std::str::from_utf8(html).ok()?;
    let start = html.find(START)?;
    let end = html[start..].find(END)? + start + END.len();
    let origin = origin(headers)?;
    let block = tokio::time::timeout(BUDGET, block(state, path, query, &origin)).await.ok()??;
    Some(format!("{}{START}{block}{END}{}", &html[..start], &html[end..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: &str = "<head><!--den:meta--><title>Den</title><meta property=\"og:title\" \
                         content=\"Den\" /><!--/den:meta--><link rel=\"icon\" href=\"/m.png\" /></head>";

    fn headers(host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, host.parse().unwrap());
        headers
    }

    #[test]
    fn reads_the_app_scheme_including_a_slug() {
        assert!(matches!(page("/movie/550-fight-club", None), Some(Page::Title { id: 550, .. })));
        assert!(matches!(page("/tv/1399", None), Some(Page::Title { id: 1399, .. })));
        assert!(matches!(page("/person/287-brad-pitt", None), Some(Page::Person { id: 287 })));
        assert!(matches!(page("/watchlist", None), Some(Page::Tab { name: "Watchlist" })));
        match page("/search", Some("q=blade+runner")) {
            Some(Page::Search { query }) => assert_eq!(query, "blade runner"),
            _ => panic!("a search carries its query"),
        }
        // Home and anything unrecognised keep the fallback rather than inventing a description.
        assert!(page("/", None).is_none());
        assert!(page("/movie/0", None).is_none());
        assert!(page("/nothing", None).is_none());
    }

    /// A title is somebody else's words, and it lands inside an attribute.
    #[test]
    fn a_name_cannot_end_the_tag_it_sits_in() {
        let out = escaped("Am\" onload=\"x() & <b>");
        assert!(!out.contains('<'), "{out}");
        assert!(!out.contains('"'), "{out}");
        assert_eq!(escaped("Ocean's 11 & Co"), "Ocean&#39;s 11 &amp; Co");
    }

    #[test]
    fn an_overview_is_cut_to_a_card_rather_than_an_essay() {
        let long = "word ".repeat(80);
        let cut = shortened(&long, 40);
        assert!(cut.chars().count() <= 41, "{cut}");
        assert!(cut.ends_with('…'));
        assert_eq!(shortened("  short  ", 40), "short");
    }

    #[test]
    fn a_card_takes_the_backdrop_and_falls_back_to_the_poster() {
        let both = serde_json::json!({ "backdrop_path": "/b.jpg", "poster_path": "/p.jpg" });
        assert_eq!(artwork(&both).unwrap(), "https://image.tmdb.org/t/p/w1280/b.jpg");
        let poster = serde_json::json!({ "poster_path": "/p.jpg" });
        assert_eq!(artwork(&poster).unwrap(), "https://image.tmdb.org/t/p/w780/p.jpg");
        assert!(artwork(&serde_json::json!({})).is_none());
    }

    #[tokio::test]
    async fn a_tab_is_named_without_asking_tmdb_anything() {
        let state = crate::handler::tests::Harness::new().state;
        let out = rewrite(&state, SHELL.as_bytes(), "/watchlist", None, &headers("d.oxy.fi"))
            .await
            .expect("a tab names itself");
        assert!(out.contains("<title>Watchlist · Den</title>"), "{out}");
        assert!(out.contains("content=\"https://d.oxy.fi/watchlist\""), "{out}");
        assert!(out.contains("https://d.oxy.fi/og.png"), "{out}");
        assert!(out.contains("not endorsed or certified by TMDB"), "{out}");
        // The block is replaced, not added to: two og:title tags would leave the answer to chance.
        assert_eq!(out.matches("og:title").count(), 1, "{out}");
        assert!(out.contains("<link rel=\"icon\""), "the rest of the head survived");
    }

    #[tokio::test]
    async fn home_and_a_shell_with_no_marked_block_are_left_alone() {
        let state = crate::handler::tests::Harness::new().state;
        assert!(rewrite(&state, SHELL.as_bytes(), "/", None, &headers("d.oxy.fi")).await.is_none());
        let plain = b"<head><title>Den</title></head>";
        assert!(rewrite(&state, plain, "/watchlist", None, &headers("d.oxy.fi")).await.is_none());
        // Without a Host there is nothing to build an absolute URL from, and a relative one is refused by
        // most of what builds a preview.
        assert!(rewrite(&state, SHELL.as_bytes(), "/watchlist", None, &HeaderMap::new()).await.is_none());
    }

    /// With no key lent, a title has nothing to describe it, and the fallback is the honest answer.
    #[tokio::test]
    async fn a_title_keeps_the_fallback_when_tmdb_cannot_be_asked() {
        let state = crate::handler::tests::Harness::new().state;
        assert!(rewrite(&state, SHELL.as_bytes(), "/movie/550", None, &headers("d.oxy.fi")).await.is_none());
    }
}
