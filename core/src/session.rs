//! A link session's framing, sans I/O: requests to wire bytes (with sequence numbers and the cable's sync byte),
//! wire bytes to answers. As `ferrite_link.py`'s `Link`: `send`, `answers`, the opening Ctrl-C and 0x00.
//!
//! The caller owns the transport and the clock: it writes what [`Session::request`] returns, feeds what it reads
//! to [`Session::feed`], and matches answers by type and seq ([`Answer::answers`]).

use crate::timing::QUIET_MS;
use ferrite_core::link::{self, ANSWER, MAX_WIRE};
use serde::Serialize;

/// Ctrl-C: closes the radio's terminal if it has the cable (TERM-2); nothing otherwise.
pub const CTRL_C: u8 = 0x03;
/// A 0x00 gives the cable to the link (TERM-2), and resyncs the radio's frame reader.
pub const SYNC: u8 = 0x00;
/// Bytes kept waiting for a delimiter: terminal text with no 0x00 must not pile up for ever.
const MAX_PENDING: usize = 4 * MAX_WIRE;

/// One answer: type (the request's | 0x80), seq, status byte, and the rest of the payload. Or an event (LINK-46):
/// a frame of type 0x51 the radio sends unasked, `seq` its own counter, no status byte (`status` 0, `rest` the whole
/// payload: the kind and its bytes), never matching a request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Answer {
    pub ty: u8,
    pub seq: u8,
    pub status: u8,
    pub rest: Vec<u8>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub event: bool,
}

impl Answer {
    /// Whether this answers request `ty` sent with `seq`.
    pub fn answers(&self, ty: u8, seq: u8) -> bool {
        !self.event && self.ty == ty | ANSWER && self.seq == seq
    }
}

/// A request ready to write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub seq: u8,
    pub wire: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// More than [`link::MAX_PAYLOAD`] bytes.
    TooLong,
}

#[derive(Clone, Debug, Default)]
pub struct Session {
    seq: u8,
    buf: Vec<u8>,
    /// When the last bytes went out (the caller's clock), None before the opening.
    sent_at: Option<f64>,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    /// The first bytes to write: Ctrl-C. Wait [`crate::timing::OPEN_SETTLE_MS`], [`Self::discard`] what came,
    /// then write [`Self::take_cable`].
    pub fn opening() -> [u8; 1] {
        [CTRL_C]
    }

    /// Drops whatever was received so far (the terminal's goodbye text).
    pub fn discard(&mut self) {
        self.buf.clear();
    }

    /// The 0x00 that gives the cable to the link, sent at `now_ms`.
    pub fn take_cable(&mut self, now_ms: f64) -> [u8; 1] {
        self.sent_at = Some(now_ms);
        [SYNC]
    }

    /// A 0x00 alone (a resync before sending a read-only request again), sent at `now_ms`.
    pub fn resync(&mut self, now_ms: f64) -> [u8; 1] {
        self.take_cable(now_ms)
    }

    /// The seq the next request takes.
    pub fn next_seq(&self) -> u8 {
        self.seq.wrapping_add(1)
    }

    /// A request at `now_ms`: the next seq, framed, a 0x00 sync first after [`QUIET_MS`] of quiet.
    pub fn request(&mut self, ty: u8, payload: &[u8], now_ms: f64) -> Result<Request, Error> {
        let seq = self.next_seq();
        let mut wire = vec![0u8; MAX_WIRE + 1];
        let quiet = self.sent_at.is_none_or(|t| now_ms - t >= QUIET_MS as f64);
        let at = quiet as usize;
        let n = link::build(ty, seq, payload, &mut wire[at..]).ok_or(Error::TooLong)?;
        wire.truncate(at + n);
        self.seq = seq;
        self.sent_at = Some(now_ms);
        Ok(Request { seq, wire })
    }

    /// Bytes read from the transport; the whole answers (and events) they complete. Frames that don't decode
    /// (terminal text, damage) are skipped, as are answers too short to carry a status byte. A type below 0x80 from
    /// the radio is always an event (it sends no requests: Appendix G).
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Answer> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(end) = self.buf.iter().position(|&b| b == 0) {
            let mut raw: Vec<u8> = self.buf.drain(..=end).collect();
            raw.pop();
            if raw.is_empty() {
                continue;
            }
            if let Ok(f) = link::parse(&mut raw) {
                if f.ty & ANSWER == 0 {
                    if !f.payload.is_empty() {
                        out.push(Answer { ty: f.ty, seq: f.seq, status: 0, rest: f.payload.to_vec(), event: true });
                    }
                } else if let Some((&status, rest)) = f.payload.split_first() {
                    out.push(Answer { ty: f.ty, seq: f.seq, status, rest: rest.to_vec(), event: false });
                }
            }
        }
        if self.buf.len() > MAX_PENDING {
            let cut = self.buf.len() - MAX_PENDING;
            self.buf.drain(..cut);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferrite_core::link::{msg, Status};

    /// The radio's side of a frame: what ferrite's codec makes of our wire bytes.
    fn radio_parse(wire: &[u8]) -> (u8, u8, Vec<u8>) {
        let body = wire.strip_prefix(&[0]).unwrap_or(wire);
        assert_eq!(body.last(), Some(&0), "delimited");
        let mut b = body[..body.len() - 1].to_vec();
        let f = link::parse(&mut b).unwrap();
        (f.ty, f.seq, f.payload.to_vec())
    }

    /// An answer as the radio builds it.
    fn radio_answer(ty: u8, seq: u8, status: Status, rest: &[u8]) -> Vec<u8> {
        let mut p = vec![status as u8];
        p.extend_from_slice(rest);
        let mut w = [0u8; MAX_WIRE];
        let n = link::build(ty | ANSWER, seq, &p, &mut w).unwrap();
        w[..n].to_vec()
    }

    /// LINK-1: requests decode with ferrite's codec, seq counting up from 1 and wrapping.
    #[test]
    fn requests_round_trip_through_ferrites_codec() {
        let mut s = Session::new();
        s.take_cable(0.0);
        let payloads: [&[u8]; 5] = [&[], &[0], &[2, 0, 0, 0, 0, 0, 0, 0, 0, b'x'], &[0; 240], &[0x55; 239]];
        for (i, p) in payloads.iter().enumerate() {
            let r = s.request(msg::UI, p, 10.0 * i as f64).unwrap();
            assert_eq!(r.seq, i as u8 + 1);
            assert!(!r.wire[..r.wire.len() - 1].contains(&0), "only the delimiter is 0 (no sync: not quiet)");
            assert_eq!(radio_parse(&r.wire), (msg::UI, r.seq, p.to_vec()));
        }
        assert_eq!(s.request(msg::UI, &[0; 241], 100.0), Err(Error::TooLong));
        let mut s = Session { seq: 254, ..Session::new() };
        assert_eq!(s.request(msg::INFO, &[], 0.0).unwrap().seq, 255);
        assert_eq!(s.request(msg::INFO, &[], 0.0).unwrap().seq, 0);
    }

    /// TERM-2: the first request, and any after 5 s of quiet, starts with a 0x00 sync.
    #[test]
    fn sync_after_quiet() {
        let mut s = Session::new();
        assert_eq!(s.request(msg::HELLO, &[], 0.0).unwrap().wire[0], 0, "nothing sent yet");
        assert_ne!(s.request(msg::INFO, &[], 4_999.0).unwrap().wire[0], 0);
        assert_eq!(s.request(msg::INFO, &[], 9_999.0).unwrap().wire[0], 0, "5 s quiet");
        let r = s.request(msg::INFO, &[], 20_000.0).unwrap();
        assert_eq!(radio_parse(&r.wire).0, msg::INFO, "the sync doesn't disturb the frame");
    }

    /// Answers built by ferrite's codec decode, split across reads, between terminal text and damage.
    #[test]
    fn answers_from_ferrites_codec() {
        let mut s = Session::new();
        let a = radio_answer(msg::HELLO, 1, Status::Ok, &[2, 240, 1]);
        let b = radio_answer(msg::UI, 2, Status::Busy, &[]);
        let mut damaged = radio_answer(msg::INFO, 3, Status::Ok, b"abc");
        damaged[3] ^= 0x40;
        let mut stream = b"goodbye\r\n\0".to_vec();
        stream.extend(&a);
        stream.extend(&damaged);
        stream.extend(&b);
        let mut got = Vec::new();
        for chunk in stream.chunks(7) {
            got.extend(s.feed(chunk));
        }
        assert_eq!(got.len(), 2);
        assert!(got[0].answers(msg::HELLO, 1));
        assert_eq!((got[0].status, got[0].rest.as_slice()), (0, &[2u8, 240, 1][..]));
        assert!(got[1].answers(msg::UI, 2));
        assert_eq!(got[1].status, Status::Busy as u8);
        assert!(!got[1].answers(msg::UI, 3));
    }

    /// LINK-46: an EVENT frame (type 0x51, no status byte) between answers comes out as an event, its whole
    /// payload kept, and never answers a request of the same seq.
    #[test]
    fn events_are_kept_apart() {
        let mut s = Session::new();
        let mut w = [0u8; MAX_WIRE];
        let n = link::build(msg::EVENT, 7, &[1, 3, 9], &mut w).unwrap();
        let mut stream = radio_answer(msg::HEARD, 7, Status::Ok, &[0]);
        stream.extend(&w[..n]);
        let got = s.feed(&stream);
        assert_eq!(got.len(), 2);
        assert!(got[0].answers(msg::HEARD, 7) && !got[0].event);
        assert!(got[1].event && got[1].rest == [1, 3, 9] && got[1].seq == 7);
        assert!(!got[1].answers(msg::EVENT & 0x7F, 7));
    }

    #[test]
    fn opening_and_pending_cap() {
        let mut s = Session::new();
        assert_eq!(Session::opening(), [3]);
        s.feed(&[b'x'; 5000]);
        assert!(s.buf.len() <= MAX_PENDING);
        s.discard();
        assert!(s.buf.is_empty());
        let a = radio_answer(msg::KEY, 9, Status::Ok, &[]);
        assert_eq!(s.feed(&a).len(), 1);
    }
}
