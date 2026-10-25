//! A link session's framing, sans I/O: requests to wire bytes (with sequence numbers and the cable's sync byte),
//! wire bytes to answers. As `ferrite_link.py`'s `Link`: `send`, `answers`, the opening Ctrl-C and 0x00.
//!
//! The caller owns the transport and the clock: it writes what [`Session::request`] returns, feeds what it reads
//! to [`Session::feed`], and matches answers by type and seq ([`Answer::answers`]).

use crate::timing::QUIET_MS;
use ferrite_core::link::{self, ANSWER, MAX_WIRE};
use ferrite_core::linkz::{LzDec, LzEnc, DOWN, UP};
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
    /// LINK-51: compression, from a `HELLO` answer that granted it.
    lz: Option<Box<Lz>>,
}

/// LINK-51: this end's windows and counts (PC to radio coded here, radio to PC decoded here).
#[derive(Clone)]
struct Lz {
    up: LzEnc<UP>,
    down: LzDec<DOWN>,
    up_n: u8,
    down_n: u8,
    /// A coded frame came with a count that doesn't match: a frame was lost, the windows are apart; a `HELLO`
    /// starts them over.
    broken: bool,
}

impl core::fmt::Debug for Lz {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "Lz {{ up_n: {}, down_n: {}, broken: {} }}", self.up_n, self.down_n, self.broken)
    }
}

/// A compressed frame's type (| 0x80 for an answer): the inner type, the count, the coded payload.
pub const Z: u8 = 0x7D;

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

    /// LINK-50: a stream's frames took the seqs after its request's; the next request goes past them.
    pub fn skip(&mut self, n: u8) {
        self.seq = self.seq.wrapping_add(n);
    }

    /// LINK-51: compression on (a `HELLO` answer granted it) or off; both windows start over either way.
    pub fn set_lz(&mut self, on: bool) {
        self.lz = on.then(|| Box::new(Lz { up: LzEnc::new(), down: LzDec::new(), up_n: 0, down_n: 0, broken: false }));
    }

    pub fn lz_on(&self) -> bool {
        self.lz.is_some()
    }

    /// LINK-51: a frame was lost while compressed: send a `HELLO` (which starts both ends over) before asking again.
    pub fn lz_broken(&self) -> bool {
        self.lz.as_ref().is_some_and(|z| z.broken)
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
        let mut coded = [0u8; MAX_WIRE];
        let (ty, payload) = match self.lz.as_mut().filter(|_| ty != link::msg::HELLO) {
            Some(z) => {
                let k = z.up.encode(payload, &mut coded[2..]); // the window takes it either way, as the radio's
                (coded[0], coded[1]) = (ty, z.up_n);
                z.up_n = z.up_n.wrapping_add(1);
                match k.filter(|&k| k + 2 < payload.len()) {
                    Some(k) => (Z, &coded[..k + 2]),
                    None => (ty, payload),
                }
            }
            None => (ty, payload),
        };
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
            if let Ok(mut f) = link::parse(&mut raw) {
                // LINK-13.4: receive audio is pushed plain, outside compression's window and count (LINK-51)
                if f.ty == link::msg::AUDIO_DATA {
                    out.push(Answer { ty: f.ty, seq: f.seq, status: 0, rest: f.payload.to_vec(), event: true });
                    continue;
                }
                let mut plain = [0u8; MAX_WIRE];
                if let Some(z) = self.lz.as_mut().filter(|_| f.ty != link::msg::HELLO | ANSWER) {
                    if f.ty & 0x7F == Z {
                        let (Some(&inner), Some(&cnt)) = (f.payload.first(), f.payload.get(1)) else { continue };
                        let k = (cnt == z.down_n).then(|| z.down.decode(&f.payload[2..], &mut plain)).flatten();
                        z.down_n = z.down_n.wrapping_add(1);
                        let Some(k) = k else {
                            z.broken = true;
                            continue;
                        };
                        f = link::Frame { ty: inner, seq: f.seq, payload: &plain[..k] };
                    } else {
                        z.down.seen(f.payload);
                        z.down_n = z.down_n.wrapping_add(1);
                    }
                }
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

    /// LINK-13.4, LINK-51: receive audio comes plain and stays out of compression's window and count, so a
    /// compressed session reads it as an event and its next coded frame still lines up.
    #[test]
    fn audio_frames_pass_compression_by() {
        let mut s = Session::new();
        s.set_lz(true);
        let mut w = [0u8; MAX_WIRE];
        let n = link::build(msg::AUDIO_DATA, 0, &[1, 0, 1, 1, 0, 0, 0, 0x37, 0x73], &mut w).unwrap();
        let a = s.feed(&w[..n]);
        assert_eq!((a.len(), a[0].ty, a[0].event, a[0].rest.len()), (1, msg::AUDIO_DATA, true, 9));
        let z = s.lz.as_ref().unwrap();
        assert_eq!((z.down_n, z.broken), (0, false), "not counted");
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

    /// LINK-51: with compression on, a request that shrinks goes as a `Z` frame the radio's codec decodes (the
    /// inner type, the count, the coded bytes); one that doesn't goes plain; the radio's `Z` answers decode here,
    /// counted; a count that doesn't match leaves the session broken until a `HELLO` turns it on again.
    #[test]
    fn compressed_frames_both_ways() {
        use ferrite_core::linkz::{LzDec, LzEnc, DOWN, UP};
        let mut s = Session::new();
        s.take_cable(0.0);
        s.set_lz(true);
        let body = [7u8; 200];
        let r = s.request(msg::WRITE_MANY, &body, 1.0).unwrap();
        let (ty, _, p) = radio_parse(&r.wire);
        assert_eq!((ty, p[0], p[1]), (Z, msg::WRITE_MANY, 0));
        let mut out = [0u8; 300];
        let k = LzDec::<UP>::new().decode(&p[2..], &mut out).unwrap();
        assert_eq!(&out[..k], &body[..]);
        let (ty, _, p) = radio_parse(&s.request(msg::INFO, &[], 2.0).unwrap().wire);
        assert_eq!((ty, p.len()), (msg::INFO, 0), "nothing to gain: plain");
        // an answer coded by the radio
        let mut e = LzEnc::<DOWN>::new();
        let mut ans = vec![0u8; 120];
        ans[0] = Status::Ok as u8;
        let mut c = [0u8; 300];
        let k = e.encode(&ans, &mut c[2..]).unwrap();
        (c[0], c[1]) = (msg::UI | ANSWER, 0);
        let mut w = [0u8; MAX_WIRE];
        let n = link::build(Z | ANSWER, 3, &c[..k + 2], &mut w).unwrap();
        let a = s.feed(&w[..n]);
        assert_eq!((a[0].ty, a[0].seq, a[0].rest.len()), (msg::UI | ANSWER, 3, 119));
        // a count that doesn't match: broken
        c[1] = 9;
        let n = link::build(Z | ANSWER, 4, &c[..k + 2], &mut w).unwrap();
        assert!(s.feed(&w[..n]).is_empty() && s.lz_broken());
        s.set_lz(true);
        assert!(!s.lz_broken());
    }
}