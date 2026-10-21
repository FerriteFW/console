//! Live View over Bluetooth (LINK-47, LINK-48): the UI readback's compact lines kept from the radio's `EVENT`s
//! (kind 4) instead of polling the text readback. The decoding is ferrite's own (`ferrite_core::liveview::apply`,
//! dictionary v1); this keeps the lines and says when the whole state must be asked for again (`SUBSCRIBE` without
//! renew).

use ferrite_core::liveview::{self, Lines, DICT_VERSION, MORE};

/// The dictionary version this Console decodes (`SUBSCRIBE`'s answer must say the same).
pub const DICT: u8 = DICT_VERSION;

/// The lines a client holds.
#[derive(Clone, Debug, Default)]
struct Held(Vec<Vec<u8>>);

impl Lines for Held {
    fn count(&self) -> usize {
        self.0.len()
    }
    fn set_count(&mut self, n: usize) {
        self.0.resize(n, Vec::new());
    }
    fn line(&self, i: usize) -> &[u8] {
        &self.0[i]
    }
    fn set_line(&mut self, i: usize, t: &[u8]) {
        self.0[i] = t.to_vec();
    }
}

/// What applying an update did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    /// The lines are whole and checked: show them.
    Shown,
    /// Part of an update; more follows before the check.
    Partial,
    /// Lost or damaged: ask for the whole state (`SUBSCRIBE` without renew); the lines wait for it.
    Resync,
}

/// A Live View client: the lines as the radio last sent them, and the last update's sequence number.
#[derive(Clone, Debug, Default)]
pub struct Client {
    lines: Held,
    last: Option<u8>,
    /// Updates applied, and those that asked for the whole state again.
    pub updates: u32,
    pub resyncs: u32,
}

impl Client {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts over: only a whole state will do next (after a new subscription).
    pub fn reset(&mut self) {
        self.last = None;
    }

    /// A UI event's payload after its kind byte.
    pub fn apply(&mut self, ev: &[u8]) -> Applied {
        match liveview::apply(&mut self.lines, ev, self.last) {
            Ok(seq) => {
                self.last = Some(seq);
                self.updates += 1;
                if ev.get(1).is_some_and(|f| f & MORE != 0) {
                    Applied::Partial
                } else {
                    Applied::Shown
                }
            }
            Err(_) => {
                // A lost update leaves the lines as they were (nothing applied); a bad or unchecked one may have
                // changed them: either way, only a whole state is taken next.
                self.last = None;
                self.resyncs += 1;
                Applied::Resync
            }
        }
    }

    /// The lines as readback text (each ending `\n`), for the UI's parser.
    pub fn text(&self) -> String {
        self.lines.0.iter().map(|l| String::from_utf8_lossy(l).into_owned() + "\n").collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radioside::RadioSide;
    use ferrite_app::term::cmd::Line;
    use ferrite_core::keys::Key;
    use ferrite_core::liveview::{compact, Track};
    use ferrite_core::msg::{Device, LiveAll};

    /// The readback's compact lines now, as the radio would send them.
    fn radio_lines(rs: &RadioSide) -> String {
        let dev = Device { tx_built: true, ..Device::default() };
        let mut out = String::new();
        let mut l = Line::new();
        let mut c = [0u8; 256];
        let mut i = 0;
        while i < 48 && ferrite_app::uistate::line(&rs.app, &rs.store, &dev, &LiveAll::default(), i, &mut l) {
            let n = compact(l.as_bytes(), &mut c);
            out.push_str(&String::from_utf8_lossy(&c[..n]));
            out.push('\n');
            i += 1;
        }
        out
    }

    /// The radio's side: the next update (as the session's `events` makes it), or None.
    fn update(t: &mut Track, rs: &RadioSide) -> Option<Vec<u8>> {
        let dev = Device { tx_built: true, ..Device::default() };
        let mut l = Line::new();
        let mut out = [0u8; 239];
        let n = t.update(
            |i, b| {
                ferrite_app::uistate::line(&rs.app, &rs.store, &dev, &LiveAll::default(), i, &mut l).then(|| {
                    b[..l.len()].copy_from_slice(l.as_bytes());
                    l.len()
                })
            },
            &mut out,
        )?;
        Some(out[..n].to_vec())
    }

    fn press(rs: &mut RadioSide, k: Key, t: &mut u32) {
        rs.app.key_down(k, *t, &rs.store);
        *t += 30;
        rs.app.key_up(k, *t, &rs.store);
        *t += 30;
        while rs.app.pop_cmd().is_some() {}
    }

    /// LINK-47, LINK-48: the client follows ferrite's tracker through screens (whole state in parts, then deltas);
    /// a lost update is noticed and the whole state asked for again (a slow link that drops one).
    #[test]
    fn follows_the_radio_and_resyncs_after_a_loss() {
        let mut rs = RadioSide::new();
        let mut t = Track::new();
        let mut c = Client::new();
        let mut now = 2000;
        let drain = |t: &mut Track, c: &mut Client, rs: &RadioSide, drop_first: bool| {
            let mut got = Vec::new();
            let mut first = true;
            while let Some(u) = update(t, rs) {
                if !(drop_first && first) {
                    got.push(c.apply(&u));
                }
                first = false;
            }
            got
        };
        let got = drain(&mut t, &mut c, &rs, false);
        assert_eq!(got.last(), Some(&Applied::Shown));
        assert_eq!(c.text(), radio_lines(&rs));
        for k in [Key::Menu, Key::Down, Key::Down] {
            press(&mut rs, k, &mut now);
            drain(&mut t, &mut c, &rs, false);
            assert_eq!(c.text(), radio_lines(&rs), "after {k:?}");
        }
        // one lost on the way: the next is refused, then the whole state puts it right
        press(&mut rs, Key::Exit, &mut now);
        let got = drain(&mut t, &mut c, &rs, true);
        press(&mut rs, Key::Exit, &mut now);
        let got2 = drain(&mut t, &mut c, &rs, false);
        assert!(got.contains(&Applied::Resync) || got2.contains(&Applied::Resync), "{got:?} {got2:?}");
        t.restart();
        c.reset();
        drain(&mut t, &mut c, &rs, false);
        assert_eq!(c.text(), radio_lines(&rs));
        assert!(c.resyncs >= 1);
    }

    /// An idle screen is a few bytes an update: the meters and the clock (Bluetooth's ~280 B/s, LINK-36).
    #[test]
    fn idle_updates_are_small() {
        let rs = RadioSide::new();
        let mut t = Track::new();
        let mut c = Client::new();
        let mut whole = 0;
        while let Some(u) = update(&mut t, &rs) {
            whole += u.len();
            c.apply(&u);
        }
        assert!(whole > 50);
        assert_eq!(update(&mut t, &rs), None, "nothing changed: nothing sent");
    }
}
