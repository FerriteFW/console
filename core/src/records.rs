//! Record transfer payloads (LINK-3 - LINK-9): `READ`, `WRITE`, `DELETE`, `BEGIN`, `END`, as `ferrite_link.py`'s
//! `Link.read`/`Link.write` lay them out. Phase 2 (channel and zone programming) builds on these; the record
//! layouts themselves are the radio's storage formats (Appendix G) and come with it.

pub use ferrite_core::link::what;

/// The most a `READ` asks for at once, and the part size a `WRITE` sends.
pub const PART: usize = 200;

/// `READ`'s payload: what, index, offset, length (`<BHHB`).
pub fn read_payload(what: u8, index: u16, offset: u16, len: u8) -> Vec<u8> {
    let mut p = vec![what];
    p.extend(index.to_le_bytes());
    p.extend(offset.to_le_bytes());
    p.push(len);
    p
}

/// A `READ` answer (after the status byte): the record's total length, and this part's bytes.
pub fn read_answer(rest: &[u8]) -> Option<(u16, &[u8])> {
    let (t, bytes) = rest.split_at_checked(2)?;
    Some((u16::from_le_bytes([t[0], t[1]]), bytes))
}

/// Reads a record part by part: ask [`Reader::next_payload`] until [`Reader::done`].
#[derive(Clone, Debug)]
pub struct Reader {
    what: u8,
    index: u16,
    pub record: Vec<u8>,
    total: Option<u16>,
}

impl Reader {
    pub fn new(what: u8, index: u16) -> Self {
        Reader { what, index, record: Vec::new(), total: None }
    }

    pub fn next_payload(&self) -> Vec<u8> {
        read_payload(self.what, self.index, self.record.len() as u16, PART as u8)
    }

    /// An answer's rest; false if it didn't parse.
    pub fn take(&mut self, rest: &[u8]) -> bool {
        let Some((total, bytes)) = read_answer(rest) else {
            return false;
        };
        self.total = Some(total);
        self.record.extend_from_slice(bytes);
        true
    }

    pub fn done(&self) -> bool {
        self.total.is_some_and(|t| self.record.len() >= t as usize)
    }
}

/// `WRITE`'s payloads for a whole record: what, index, offset, total length (`<BHHH`), then the part's bytes; one
/// even for an empty record. The radio applies the record when the last part arrives.
pub fn write_payloads(what: u8, index: u16, record: &[u8]) -> Vec<Vec<u8>> {
    let total = record.len() as u16;
    let mut out = Vec::new();
    let mut off = 0;
    loop {
        let end = (off + PART).min(record.len());
        let mut p = vec![what];
        p.extend(index.to_le_bytes());
        p.extend((off as u16).to_le_bytes());
        p.extend(total.to_le_bytes());
        p.extend_from_slice(&record[off..end]);
        out.push(p);
        off = end;
        if off >= record.len() {
            return out;
        }
    }
}

/// `DELETE`'s payload: what, index (`<BH`).
pub fn delete_payload(what: u8, index: u16) -> Vec<u8> {
    let mut p = vec![what];
    p.extend(index.to_le_bytes());
    p
}

/// `BEGIN`'s payload: how many records the write session writes (LINK-9: the radio shows its progress).
pub fn begin_payload(records: u16) -> Vec<u8> {
    records.to_le_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_in_parts() {
        assert_eq!(read_payload(what::CHANNEL, 11, 0, 64), [2, 11, 0, 0, 0, 64]);
        let mut r = Reader::new(what::CHANNEL, 300);
        assert_eq!(r.next_payload(), [2, 0x2C, 1, 0, 0, 200]);
        let mut a = 250u16.to_le_bytes().to_vec();
        a.extend([7u8; 200]);
        assert!(r.take(&a) && !r.done());
        assert_eq!(r.next_payload(), [2, 0x2C, 1, 200, 0, 200]);
        let mut b = 250u16.to_le_bytes().to_vec();
        b.extend([8u8; 50]);
        assert!(r.take(&b) && r.done());
        assert_eq!(r.record.len(), 250);
        assert!(!r.take(&[1]));
    }

    #[test]
    fn write_in_parts() {
        let rec: Vec<u8> = (0..450u16).map(|i| i as u8).collect();
        let p = write_payloads(what::ZONE, 3, &rec);
        assert_eq!(p.len(), 3);
        assert_eq!(&p[0][..7], &[3, 3, 0, 0, 0, 0xC2, 1]);
        assert_eq!(&p[2][..7], &[3, 3, 0, 144, 1, 0xC2, 1]);
        assert_eq!(p.iter().map(|x| x.len() - 7).sum::<usize>(), 450);
        assert_eq!(write_payloads(what::SETTINGS, 0, &[]), vec![vec![1, 0, 0, 0, 0, 0, 0]]);
        assert_eq!(delete_payload(what::CHANNEL, 999), [2, 0xE7, 3]);
        assert_eq!(begin_payload(2), [2, 0]);
    }

    /// A WRITE part always fits in one frame.
    #[test]
    fn parts_fit_a_frame() {
        for p in write_payloads(what::CHANNEL, 0, &[0; 1000]) {
            assert!(p.len() <= ferrite_core::link::MAX_PAYLOAD);
        }
    }
}
