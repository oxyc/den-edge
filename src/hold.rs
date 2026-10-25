//! Held requests: a read with nothing to answer yet waits, up to a bound, for a write to one of the things it reads
//! (a library's `/changes?wait=`, the inbox's `POST /inbox/drain?wait=`), so a client hears of a change at once
//! instead of at its next poll. A write wakes only the requests waiting on what it wrote; nothing polls or scans.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

/// The longest a request is held, in seconds: inside the 30 s and longer idle timeouts of the clients and proxies in
/// front of den-edge.
pub const MAX_WAIT_SECS: u64 = 25;

/// How long a request asking `?wait=` may be held, or `None` for an ordinary answer.
pub fn wait(query: Option<String>) -> Option<Duration> {
    let seconds = query?.parse::<u64>().ok().filter(|seconds| *seconds > 0)?;
    Some(Duration::from_secs(seconds.min(MAX_WAIT_SECS)))
}

/// The requests held on one route. Each one is charged to an owner — the library it reads, or the address it came
/// from — and both the owner's count and the total are capped: past either, a request is answered at once.
pub struct Holds {
    state: Mutex<State>,
    max_total: usize,
    max_per_owner: usize,
    /// Set once, when the process starts to stop (`release_all`). A held request is then answered at once with what
    /// it would have got at its timeout, so a restart's drain is not kept open up to 25 s by a request that is only
    /// waiting, and is cut at the drain deadline with no answer at all.
    stopping: tokio::sync::watch::Sender<bool>,
}

#[derive(Default)]
struct State {
    /// The requests waiting on each key, by their id.
    waiting: HashMap<String, Vec<(u64, Arc<Notify>)>>,
    owners: HashMap<String, usize>,
    active: HashMap<u64, String>,
    total: usize,
    next: u64,
}

impl Holds {
    pub fn new(max_total: usize, max_per_owner: usize) -> Self {
        Self {
            state: Mutex::default(),
            max_total,
            max_per_owner,
            stopping: tokio::sync::watch::Sender::new(false),
        }
    }

    /// The process is stopping: answer every held request now, and hold no more.
    pub fn release_all(&self) {
        self.stopping.send_replace(true);
    }

    /// A place for a request charged to `owner`, woken by a write to any of `keys`, or `None` when a cap is
    /// reached or the process is stopping. Taken before the request reads what it would answer, so a write that
    /// lands between that read and the wait still wakes it.
    pub fn hold(&self, owner: &str, keys: &[&str]) -> Option<Hold<'_>> {
        if *self.stopping.borrow() {
            return None;
        }
        let mut state = crate::lock(&self.state);
        if state.total >= self.max_total
            || state.owners.get(owner).copied().unwrap_or(0) >= self.max_per_owner
        {
            return None;
        }
        state.total += 1;
        *state.owners.entry(owner.to_owned()).or_default() += 1;
        state.next += 1;
        let id = state.next;
        state.active.insert(id, owner.to_owned());
        let notify = Arc::new(Notify::new());
        for key in keys {
            state.waiting.entry((*key).to_owned()).or_default().push((id, Arc::clone(&notify)));
        }
        let keys = keys.iter().map(|key| (*key).to_owned()).collect();
        Some(Hold { holds: self, id, owner: owner.to_owned(), keys, notify })
    }

    /// Answer every request held on `key`: a write to it committed.
    pub fn wake(&self, key: &str) {
        if let Some(waiting) = crate::lock(&self.state).waiting.get(key) {
            // `notify_one` keeps a permit for a request that has not reached its wait yet.
            for (_, notify) in waiting {
                notify.notify_one();
            }
        }
    }

    /// Remove and wake this owner's current holds before admitting a replacement request. The removed hold's
    /// eventual drop is a no-op, so the replacement can take the same bounded slot immediately.
    pub fn cancel_owner(&self, owner: &str) {
        let notifications = {
            let mut state = crate::lock(&self.state);
            let ids: HashSet<u64> = state
                .active
                .iter()
                .filter(|(_, held_owner)| *held_owner == owner)
                .map(|(id, _)| *id)
                .collect();
            if ids.is_empty() {
                return;
            }
            let mut notifications = Vec::new();
            for waiting in state.waiting.values_mut() {
                waiting.retain(|(id, notify)| {
                    if ids.contains(id) {
                        notifications.push(Arc::clone(notify));
                        false
                    } else {
                        true
                    }
                });
            }
            state.waiting.retain(|_, waiting| !waiting.is_empty());
            state.total = state.total.saturating_sub(ids.len());
            state.active.retain(|id, _| !ids.contains(id));
            state.owners.remove(owner);
            notifications
        };
        for notify in notifications {
            notify.notify_one();
        }
    }

    #[cfg(test)]
    pub fn held_by(&self, owner: &str) -> usize {
        crate::lock(&self.state).owners.get(owner).copied().unwrap_or(0)
    }
}

/// One held request's place; dropping it gives the place back.
pub struct Hold<'a> {
    holds: &'a Holds,
    id: u64,
    owner: String,
    keys: Vec<String>,
    notify: Arc<Notify>,
}

impl Hold<'_> {
    /// Until a write to one of its keys, `wait` passes, or the process starts to stop.
    pub async fn wait(&self, wait: Duration) {
        // `wait_for` looks at the current value first, so a stop that came before this subscribed still ends it.
        let mut stopping = self.holds.stopping.subscribe();
        tokio::select! {
            _ = tokio::time::timeout(wait, self.notify.notified()) => {}
            _ = stopping.wait_for(|stopping| *stopping) => {}
        }
    }
}

impl Drop for Hold<'_> {
    fn drop(&mut self) {
        let mut state = crate::lock(&self.holds.state);
        if state.active.remove(&self.id).is_none() {
            return;
        }
        state.total -= 1;
        if let Some(count) = state.owners.get_mut(&self.owner) {
            *count -= 1;
            if *count == 0 {
                state.owners.remove(&self.owner);
            }
        }
        for key in &self.keys {
            if let Some(waiting) = state.waiting.get_mut(key) {
                waiting.retain(|(id, _)| *id != self.id);
                if waiting.is_empty() {
                    state.waiting.remove(key);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHORT: Duration = Duration::from_millis(50);

    #[tokio::test]
    async fn a_write_wakes_only_the_requests_waiting_on_its_key() {
        let holds = Holds::new(8, 8);
        let a = holds.hold("o", &["a"]).unwrap();
        let both = holds.hold("o", &["a", "b"]).unwrap();
        let b = holds.hold("o", &["b"]).unwrap();
        holds.wake("b");
        assert!(tokio::time::timeout(SHORT, a.wait(Duration::from_secs(5))).await.is_err());
        // Woken before it waited: the permit is kept.
        assert!(tokio::time::timeout(SHORT, both.wait(Duration::from_secs(5))).await.is_ok());
        assert!(tokio::time::timeout(SHORT, b.wait(Duration::from_secs(5))).await.is_ok());
    }

    #[tokio::test]
    async fn the_caps_bound_holds_per_owner_and_in_total_and_a_drop_gives_the_place_back() {
        let holds = Holds::new(3, 2);
        let first = holds.hold("one", &["k"]).unwrap();
        let _second = holds.hold("one", &["k"]).unwrap();
        assert!(holds.hold("one", &["k"]).is_none(), "per owner");
        let _third = holds.hold("two", &["k"]).unwrap();
        assert!(holds.hold("three", &["k"]).is_none(), "in total");
        drop(first);
        assert!(holds.hold("one", &["k"]).is_some());
    }

    /// A stop ends a wait already under way and one that starts after it, and no new request is held.
    #[tokio::test]
    async fn a_stop_ends_every_wait_and_holds_no_more() {
        let holds = Holds::new(8, 8);
        let before = holds.hold("o", &["k"]).unwrap();
        let mut waiting = Box::pin(before.wait(Duration::from_secs(25)));
        assert!(tokio::time::timeout(SHORT, &mut waiting).await.is_err(), "held until the stop");
        let late = holds.hold("o", &["k"]).unwrap();
        holds.release_all();
        assert!(tokio::time::timeout(SHORT, waiting).await.is_ok(), "a wait under way");
        assert!(
            tokio::time::timeout(SHORT, late.wait(Duration::from_secs(25))).await.is_ok(),
            "a wait after"
        );
        assert!(holds.hold("o", &["k"]).is_none(), "nothing more is held");
    }

    #[test]
    fn a_wait_is_bounded_and_zero_or_junk_is_none() {
        assert_eq!(wait(Some("10".into())), Some(Duration::from_secs(10)));
        assert_eq!(wait(Some("600".into())), Some(Duration::from_secs(MAX_WAIT_SECS)));
        assert_eq!(wait(Some("0".into())), None);
        assert_eq!(wait(Some("soon".into())), None);
        assert_eq!(wait(None), None);
    }
}
