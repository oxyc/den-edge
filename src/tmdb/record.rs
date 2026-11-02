//! A title's whole detail, kept once as a segmented record (`super::Detail`).
//!
//! Each client asks for a title's detail with its own subset of sub-requests. The record holds TMDB's answer as it
//! was sent, which is what a question for every sub-request is served, and the same object cut into members in the
//! order `serde_json` writes a parsed object back (its keys sorted): runs of the title's own fields, and one range per
//! sub-request. A narrower question is answered by joining the ranges it asks for. Nothing is parsed on a hit, and
//! the bytes are the ones a parse and re-serialisation of the whole answer gave, which is how a subset was served
//! before records existed.
//!
//! Layout, little-endian: `MAGIC`; the digest of TMDB's body (16 bytes); flags (1); segment count `N` (1); the
//! length `E` of TMDB's ETag (2); `N` entries of (u32 offset, u32 length, u32 mask); the ETag; then the payload.
//! Entry 0 is TMDB's body as sent. The rest, in order, are joined with commas inside braces: mask 0 is a run of the
//! title's own fields, bit `i` sub-request `i` of the kind's list (`super::MOVIE_APPENDS`, `super::TV_APPENDS`).

use sha2::{Digest, Sha256};
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

const MAGIC: &[u8; 8] = b"DENDTL1\0";
const FIXED: usize = 28;
const ENTRY: usize = 12;
/// A remembered 404: no segments, nothing to serve.
const ABSENT: u8 = 1;
/// TMDB's body was not a JSON object, so it cannot be cut: every question is served it as sent.
const OPAQUE: u8 = 2;
/// Read with the header in one call. A typical film's record (TMDB's ~25 KB and its members) fits; a larger one has
/// only the ranges its question needs read after it.
pub(super) const PREFIX_BYTES: usize = 64 * 1024;

pub(super) struct Header {
    pub digest: [u8; 16],
    flags: u8,
    pub etag: Option<String>,
    /// (offset, length, mask), entry 0 TMDB's body.
    segments: Vec<(u32, u32, u32)>,
}

impl Header {
    pub fn absent(&self) -> bool {
        self.flags & ABSENT != 0
    }

    /// The ranges that answer `asked` (a mask over the kind's sub-requests, `every` all of them), and whether they
    /// are joined inside braces. `own` asks for the title's own fields alone.
    fn ranges(&self, asked: u32, every: u32) -> (Vec<(u32, u32)>, bool) {
        if self.flags & OPAQUE != 0 || asked == every {
            return (self.segments.first().map(|&(at, len, _)| (at, len)).into_iter().collect(), false);
        }
        let ranges = self
            .segments
            .get(1..)
            .unwrap_or_default()
            .iter()
            .filter(|(_, _, mask)| *mask == 0 || mask & asked != 0)
            .map(|&(at, len, _)| (at, len))
            .collect();
        (ranges, true)
    }

    /// How long the answer to `asked` is.
    pub fn answer_len(&self, asked: u32, every: u32) -> usize {
        let (ranges, framed) = self.ranges(asked, every);
        let joined: usize = ranges.iter().map(|&(_, len)| len as usize).sum();
        if framed {
            joined + ranges.len().saturating_sub(1) + 2
        } else {
            joined
        }
    }
}

/// The record for TMDB's `raw` answer to a whole detail question of a kind whose sub-requests are `all`.
pub(super) fn build(raw: &[u8], all: &[&str], etag: Option<&str>) -> Vec<u8> {
    let mut members: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut flags = 0;
    match serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(raw) {
        Ok(record) => {
            for (key, value) in &record {
                let mask = all.iter().position(|append| append == key).map_or(0, |at| 1u32 << at);
                let mut member = serde_json::to_vec(key).expect("a string always serialises");
                member.push(b':');
                serde_json::to_writer(&mut member, value).expect("a parsed value always serialises");
                match members.last_mut() {
                    Some((0, run)) if mask == 0 => {
                        run.push(b',');
                        run.extend_from_slice(&member);
                    }
                    _ => members.push((mask, member)),
                }
            }
        }
        Err(_) => flags |= OPAQUE,
    }
    let etag = etag.filter(|etag| etag.len() <= u16::MAX as usize).unwrap_or("");
    assemble(&Sha256::digest(raw)[..16], flags, etag, raw, &members)
}

/// A remembered 404.
pub(super) fn absent() -> Vec<u8> {
    assemble(&[0; 16], ABSENT, "", &[], &[])
}

fn assemble(digest: &[u8], flags: u8, etag: &str, raw: &[u8], members: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let count = if flags & ABSENT != 0 { 0 } else { 1 + members.len() };
    let start = FIXED + count * ENTRY + etag.len();
    let payload = raw.len() + members.iter().map(|(_, member)| member.len()).sum::<usize>();
    let mut out = Vec::with_capacity(start + payload);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(digest);
    out.push(flags);
    out.push(u8::try_from(count).expect("a detail has at most one member per sub-request and run between"));
    out.extend_from_slice(&(etag.len() as u16).to_le_bytes());
    let mut at = start;
    let mut entry = |out: &mut Vec<u8>, len: usize, mask: u32| {
        out.extend_from_slice(&(at as u32).to_le_bytes());
        out.extend_from_slice(&(len as u32).to_le_bytes());
        out.extend_from_slice(&mask.to_le_bytes());
        at += len;
    };
    if count > 0 {
        entry(&mut out, raw.len(), u32::MAX);
        for (mask, member) in members {
            entry(&mut out, member.len(), *mask);
        }
    }
    out.extend_from_slice(etag.as_bytes());
    if count > 0 {
        out.extend_from_slice(raw);
        for (_, member) in members {
            out.extend_from_slice(member);
        }
    }
    out
}

/// The header at the start of `bytes`, checked against a file of `file_len` bytes. `None` for anything that is not
/// a whole, consistent record: a torn or foreign file is a miss, never a wrong answer.
pub(super) fn header(bytes: &[u8], file_len: u64) -> Option<Header> {
    if bytes.len() < FIXED || &bytes[..8] != MAGIC {
        return None;
    }
    let count = usize::from(bytes[25]);
    let etag_len = usize::from(u16::from_le_bytes([bytes[26], bytes[27]]));
    let table_end = FIXED + count * ENTRY;
    let start = table_end + etag_len;
    if bytes.len() < start {
        return None;
    }
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().expect("four bytes"));
    let mut segments = Vec::with_capacity(count);
    let mut expected = start as u64;
    for entry in 0..count {
        let at = FIXED + entry * ENTRY;
        let (offset, len, mask) = (word(at), word(at + 4), word(at + 8));
        if u64::from(offset) != expected {
            return None;
        }
        expected += u64::from(len);
        segments.push((offset, len, mask));
    }
    if expected != file_len {
        return None;
    }
    let etag = std::str::from_utf8(&bytes[table_end..start]).ok()?;
    Some(Header {
        digest: bytes[8..24].try_into().expect("sixteen bytes"),
        flags: bytes[24],
        etag: (!etag.is_empty()).then(|| etag.to_owned()),
        segments,
    })
}

/// The answer to `asked` and the title's own fields, read through `read(offset, len, into)`.
pub(super) fn answer(
    header: &Header,
    asked: u32,
    every: u32,
    mut read: impl FnMut(u32, u32, &mut Vec<u8>) -> io::Result<()>,
) -> io::Result<(Vec<u8>, Option<Vec<u8>>)> {
    let (ranges, framed) = header.ranges(asked, every);
    let body = join(&ranges, framed, &mut read)?;
    // What freshness is judged on (`super::unfinished`): TMDB's body when that is what is served, else the title's
    // own fields as a bare question would be answered.
    let own = if framed {
        let (ranges, _) = header.ranges(0, every);
        Some(join(&ranges, true, &mut read)?)
    } else {
        None
    };
    Ok((body, own))
}

/// `ranges` read one after another, joined with commas inside braces when `framed`.
fn join(
    ranges: &[(u32, u32)],
    framed: bool,
    read: &mut impl FnMut(u32, u32, &mut Vec<u8>) -> io::Result<()>,
) -> io::Result<Vec<u8>> {
    let joined = ranges.iter().map(|&(_, len)| len as usize + 1).sum::<usize>();
    let mut out = Vec::with_capacity(joined + 2);
    if framed {
        out.push(b'{');
    }
    for (at, &(offset, len)) in ranges.iter().enumerate() {
        if at > 0 {
            out.push(b',');
        }
        read(offset, len, &mut out)?;
    }
    if framed {
        out.push(b'}');
    }
    Ok(out)
}

/// A record opened from disk, its header read: one open, and the first `PREFIX_BYTES` in one read, which for a
/// typical title is the whole record.
pub(super) struct Reading {
    file: std::fs::File,
    prefix: Vec<u8>,
    pub header: Header,
    pub modified: SystemTime,
    pub age: Duration,
}

/// Open the record at `path`. `Ok(None)` when there is none or it is not a whole one. Blocking.
pub(super) fn begin(path: &Path) -> io::Result<Option<Reading>> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    let file_len = metadata.len();
    let mut prefix = vec![0; usize::try_from(file_len).unwrap_or(usize::MAX).min(PREFIX_BYTES)];
    read_at(&mut file, 0, &mut prefix)?;
    let header = match header(&prefix, file_len) {
        Some(header) => header,
        None if prefix.len() >= FIXED && &prefix[..8] == MAGIC => {
            // A table longer than the prefix: read exactly the header it names.
            let count = usize::from(prefix[25]);
            let etag_len = usize::from(u16::from_le_bytes([prefix[26], prefix[27]]));
            let mut whole = vec![0; FIXED + count * ENTRY + etag_len];
            if whole.len() as u64 > file_len {
                return Ok(None);
            }
            read_at(&mut file, 0, &mut whole)?;
            match self::header(&whole, file_len) {
                Some(header) => header,
                None => return Ok(None),
            }
        }
        None => return Ok(None),
    };
    let now = SystemTime::now();
    let modified = metadata.modified().map_or(now, |modified| modified.min(now));
    Ok(Some(Reading {
        file,
        prefix,
        header,
        modified,
        age: now.duration_since(modified).unwrap_or_default(),
    }))
}

fn read_at(file: &mut std::fs::File, at: u64, into: &mut [u8]) -> io::Result<()> {
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(at))?;
    file.read_exact(into)
}

impl Reading {
    /// This generation, confirmed by TMDB: its time set to now and all of it read, from the file as it was opened,
    /// never a record that replaced it since. Blocking.
    pub fn renewed(mut self) -> io::Result<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        self.file.set_modified(SystemTime::now())?;
        let mut all = Vec::new();
        self.file.seek(SeekFrom::Start(0))?;
        self.file.read_to_end(&mut all)?;
        Ok(all)
    }

    /// The answer to `asked` and the title's own fields (`answer`), any range past the prefix read on its own.
    /// Blocking.
    pub fn finish(&mut self, asked: u32, every: u32) -> io::Result<(Vec<u8>, Option<Vec<u8>>)> {
        let (prefix, file) = (&self.prefix, &mut self.file);
        answer(&self.header, asked, every, |offset, len, out| {
            let (start, end) = (offset as usize, offset as usize + len as usize);
            if end <= prefix.len() {
                out.extend_from_slice(&prefix[start..end]);
                return Ok(());
            }
            let at = out.len();
            out.resize(at + len as usize, 0);
            read_at(file, u64::from(offset), &mut out[at..])
        })
    }
}

/// The answer to `asked` from a record held in memory, as `open` reads it from disk.
pub(super) fn answer_in(record: &[u8], asked: u32, every: u32) -> Option<(Header, Vec<u8>, Option<Vec<u8>>)> {
    let header = header(record, record.len() as u64)?;
    let (body, own) = answer(&header, asked, every, |offset, len, out| {
        out.extend_from_slice(&record[offset as usize..offset as usize + len as usize]);
        Ok(())
    })
    .ok()?;
    Some((header, body, own))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [&str; 3] = ["credits", "videos", "watch/providers"];
    const EVERY: u32 = 0b111;

    /// What a subset was served before records: the whole parsed, its unasked sub-requests removed, written back.
    fn reparsed(raw: &[u8], asked: u32) -> Vec<u8> {
        let mut record: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(raw).unwrap();
        for (at, append) in ALL.iter().enumerate() {
            if asked & (1 << at) == 0 {
                record.remove(*append);
            }
        }
        serde_json::to_vec(&record).unwrap()
    }

    #[test]
    fn every_subset_is_the_bytes_a_reparse_gave_and_everything_is_tmdbs_own() {
        // TMDB's order and spelling, which a reparse changes: keys out of order, an escaped slash, a float with a
        // trailing zero, a non-ASCII name written both ways.
        let raw = format!(
            r#"{{"title":"Am{}u00e9lie","original_title":"Amélie","watch/providers":{{"results":{{}}}},"id":194,"credits":{{"cast":[{{"name":"Audrey"}}]}},"vote_average":7.90,"adult":false,"videos":{{"results":[{{"key":"a\/b"}}]}},"zz":null}}"#,
            '\\'
        );
        let raw = raw.as_bytes();
        let record = build(raw, &ALL, Some("\"tag\""));
        for asked in 0..EVERY {
            let (header, body, own) = answer_in(&record, asked, EVERY).unwrap();
            assert_eq!(body, reparsed(raw, asked), "subset {asked:03b}");
            assert_eq!(header.answer_len(asked, EVERY), body.len());
            assert_eq!(own.unwrap(), reparsed(raw, 0));
        }
        let (header, body, own) = answer_in(&record, EVERY, EVERY).unwrap();
        assert_eq!(body, raw, "a question for everything gets TMDB's bytes");
        assert!(own.is_none());
        assert_eq!(header.etag.as_deref(), Some("\"tag\""));
        assert_eq!(header.digest, Sha256::digest(raw)[..16]);
    }

    #[test]
    fn a_body_that_is_not_an_object_is_served_as_sent_and_a_torn_record_is_nothing() {
        let record = build(b"[1,2]", &ALL, None);
        assert_eq!(answer_in(&record, 1, EVERY).unwrap().1, b"[1,2]");
        let full = build(br#"{"id":1,"credits":{}}"#, &ALL, None);
        for cut in [0, 8, FIXED, full.len() - 1] {
            assert!(header(&full[..cut], cut as u64).is_none(), "cut at {cut}");
        }
        assert!(header(&full, full.len() as u64 + 1).is_none());
        assert!(header(&absent(), absent().len() as u64).unwrap().absent());
        let empty = build(b"{}", &ALL, None);
        assert_eq!(answer_in(&empty, 1, EVERY).unwrap().1, b"{}");
    }
}
