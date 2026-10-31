//! Ferrite's own radio side of the link, in memory: ferrite-app's `App` and `link::Session` (the code the radio
//! runs) over a channel store kept here ([`MemStore`]: 1,000 channels, 254 zones, like the radio's). The demo radio
//! answers records through it, and [`crate::plan`] dry-runs a write through it before anything goes to a radio,
//! so every check and refusal is the firmware's own, never a copy.

use ferrite_app::chan::{ChanWrite, Channel, ChannelStore, Name, MAX_CHANNELS, NO_ZONE};
use ferrite_app::data::{Data, Dtmf, Event, Op, Pos, RangePreset, Src, Waypoint, ZoneCfg, DTMF_MEMS};
use ferrite_ui::text::Buf;
use ferrite_app::link::Session;
use ferrite_app::screens::alert::AlertInfo;
use ferrite_app::settings::Settings;
use ferrite_app::App;
use ferrite_core::link::{self, MAX_WIRE};
use ferrite_core::msg::{Device, LiveAll};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

/// The most zones the radio stores (0-253; 255 is "no zone").
pub const MAX_ZONES: usize = 254;

/// Channels by number and zones by index, in memory: ferrite's `ChannelStore` and the zone half of its `Data`.
#[derive(Default)]
pub struct MemStore {
    pub chans: RefCell<BTreeMap<u16, Channel>>,
    pub zones: RefCell<Vec<(Name, ZoneCfg)>>,
    /// Channel positions (CHAN-2, LINK-53), by number.
    pub pos: RefCell<BTreeMap<u16, Pos>>,
    /// The owner's quick messages (TEXT-7, LINK-54): None the factory text.
    pub quick: RefCell<[Option<Buf<67>>; ferrite_app::words::QUICK]>,
    /// The waypoints, newest first (GPS-10, LINK-55).
    pub waypoints: RefCell<Vec<Waypoint>>,
    /// The DTMF memories and their names (DTMF-12, LINK-56).
    pub dtmf: RefCell<[(Option<Dtmf>, Buf<10>); DTMF_MEMS as usize]>,
    /// The event log, newest first, and how many were ever logged (the sequence numbers, LINK-42, LINK-57).
    pub events: RefCell<Vec<Event>>,
    pub logged: Cell<u32>,
    /// Range presets (MENU 0 1 4), in order; up to 16.
    pub presets: RefCell<Vec<RangePreset>>,
    /// Each preset's skipped frequencies (SCAN-10, LINK-58), beside it: they move with it.
    pub preset_skips: RefCell<Vec<Vec<u32>>>,
    version: Cell<u32>,
}

impl MemStore {
    /// A write from the App (`App::pop_write`), as the radio's Storage task makes it.
    pub fn apply(&self, w: ChanWrite) {
        let mut c = self.chans.borrow_mut();
        match w {
            ChanWrite::Put { ch, from } => {
                if let Some(f) = from {
                    c.remove(&f);
                }
                c.insert(ch.num, ch);
            }
            ChanWrite::PutPos { ch, pos } => {
                c.insert(ch.num, ch);
                self.set_pos(ch.num, pos);
            }
            ChanWrite::Pos { num, pos } if c.contains_key(&num) => self.set_pos(num, pos),
            ChanWrite::Pos { .. } => {}
            ChanWrite::Delete(n) => {
                c.remove(&n);
                self.pos.borrow_mut().remove(&n);
            }
            ChanWrite::DeleteZone(z) => c.values_mut().filter(|x| x.zone == z).for_each(|x| x.zone = NO_ZONE),
            ChanWrite::EraseAll => c.clear(),
        }
        self.bump();
    }

    fn set_pos(&self, num: u16, pos: Option<Pos>) {
        match pos {
            Some(p) => self.pos.borrow_mut().insert(num, p),
            None => self.pos.borrow_mut().remove(&num),
        };
    }

    /// An event logged now (a DTMF sequence heard, `text`): what the event log subscription sends (LINK-57).
    pub fn log(&self, text: &str) {
        let e = Event { src: Src::Dtmf, ago_s: 0, freq: 14_652_000, slot: 0, unread: true, id: 0, x: 0, y: 0, pos: None, name: Buf::new(), text: Buf::from(text.as_bytes()) };
        self.events.borrow_mut().insert(0, e);
        self.logged.set(self.logged.get() + 1);
        self.bump();
    }

    fn bump(&self) {
        self.version.set(self.version.get().wrapping_add(1));
    }

    fn edit(&self, n: u16, f: impl FnOnce(&mut Channel)) -> bool {
        let ok = self.chans.borrow_mut().get_mut(&n).map(f).is_some();
        self.bump();
        ok
    }
}

impl ChannelStore for MemStore {
    fn zones(&self) -> u8 {
        self.zones.borrow().len() as u8
    }
    fn zone_name(&self, zone: u8) -> Option<Name> {
        self.zones.borrow().get(zone as usize).map(|z| z.0)
    }
    fn zone_len(&self, zone: u8) -> u16 {
        self.chans.borrow().values().filter(|c| c.zone == zone).count() as u16
    }
    fn zone_at(&self, zone: u8, i: u16) -> Option<Channel> {
        self.chans.borrow().values().filter(|c| c.zone == zone).nth(i as usize).copied()
    }
    fn count(&self) -> u16 {
        self.chans.borrow().len() as u16
    }
    fn by_num(&self, num: u16) -> Option<(Channel, u16)> {
        let c = *self.chans.borrow().get(&num)?;
        let i = self.chans.borrow().values().filter(|x| x.zone == c.zone && x.num < num).count() as u16;
        Some((c, i))
    }
    fn get(&self, num: u16) -> Option<Channel> {
        self.chans.borrow().get(&num).copied()
    }
    fn by_number(&self, i: u16) -> Option<Channel> {
        self.chans.borrow().values().nth(i as usize).copied()
    }
    fn position(&self, num: u16) -> Option<Pos> {
        self.pos.borrow().get(&num).copied().filter(|_| self.chans.borrow().contains_key(&num))
    }
    fn data(&self) -> &dyn Data {
        self
    }
}

impl Data for MemStore {
    fn version(&self) -> u32 {
        self.version.get()
    }
    fn zone_cfg(&self, zone: u8) -> ZoneCfg {
        self.zones.borrow().get(zone as usize).map(|z| z.1).unwrap_or_default()
    }
    fn quick(&self, i: usize) -> Option<Buf<67>> {
        self.quick.borrow().get(i).copied().flatten()
    }
    fn waypoints(&self) -> u16 {
        self.waypoints.borrow().len() as u16
    }
    fn waypoint(&self, i: u16) -> Option<Waypoint> {
        self.waypoints.borrow().get(i as usize).copied()
    }
    fn dtmf(&self, i: u8) -> Option<Dtmf> {
        self.dtmf.borrow().get(i as usize).and_then(|m| m.0)
    }
    fn dtmf_name(&self, i: u8) -> Buf<10> {
        self.dtmf.borrow().get(i as usize).map_or(Buf::new(), |m| m.1)
    }
    fn events(&self) -> u16 {
        self.events.borrow().len() as u16
    }
    fn event(&self, i: u16) -> Option<Event> {
        self.events.borrow().get(i as usize).copied()
    }
    fn event_seq(&self, i: u16) -> Option<u32> {
        (i < self.events()).then(|| self.logged.get() - 1 - i as u32)
    }
    fn presets(&self) -> u8 {
        self.presets.borrow().len() as u8
    }
    fn preset(&self, i: u8) -> Option<RangePreset> {
        self.presets.borrow().get(i as usize).copied()
    }
    fn preset_skip(&self, i: u8, j: u8) -> Option<u32> {
        let n = self.preset(i)?.skips;
        self.preset_skips.borrow().get(i as usize)?.get(j as usize).copied().filter(|_| j < n)
    }
    fn request(&self, op: Op) -> bool {
        let ok = match op {
            Op::DeleteChannel(n) => self.chans.borrow_mut().remove(&n).is_some(),
            Op::Skip(n, on) => self.edit(n, |c| {
                c.flags =
                    if on { c.flags | ferrite_app::chan::FLAG_SKIP } else { c.flags & !ferrite_app::chan::FLAG_SKIP }
            }),
            Op::Hide(n, on) => self.edit(n, |c| {
                c.flags = if on {
                    c.flags | ferrite_app::chan::FLAG_HIDDEN
                } else {
                    c.flags & !ferrite_app::chan::FLAG_HIDDEN
                }
            }),
            Op::Move(n, z) => self.edit(n, |c| c.zone = z),
            Op::Renumber(n, to) => {
                let mut c = self.chans.borrow_mut();
                match (c.contains_key(&to), c.remove(&n)) {
                    (false, Some(mut ch)) => {
                        ch.num = to;
                        c.insert(to, ch);
                        true
                    }
                    (_, Some(ch)) => {
                        c.insert(n, ch);
                        false
                    }
                    _ => false,
                }
            }
            Op::PutZone(z, name, cfg) => {
                let mut zs = self.zones.borrow_mut();
                match (z as usize).cmp(&zs.len()) {
                    core::cmp::Ordering::Less => {
                        zs[z as usize] = (name, cfg);
                        true
                    }
                    core::cmp::Ordering::Equal if zs.len() < MAX_ZONES => {
                        zs.push((name, cfg));
                        true
                    }
                    _ => false,
                }
            }
            Op::NewZone => {
                let mut zs = self.zones.borrow_mut();
                let n = zs.len();
                (n < MAX_ZONES)
                    .then(|| zs.push((Name::from(format!("Zone {}", n + 1).as_bytes()), ZoneCfg::default())))
                    .is_some()
            }
            Op::Zone(z, cfg) => self.zones.borrow_mut().get_mut(z as usize).map(|x| x.1 = cfg).is_some(),
            // LINK-54 – LINK-56: as the radio's store keeps them
            Op::Quick(i, t) => self.quick.borrow_mut().get_mut(i as usize).map(|q| *q = t).is_some(),
            Op::PutWaypoint(i, w) => {
                let mut ws = self.waypoints.borrow_mut();
                let n = ws.len();
                match ws.get_mut(i as usize) {
                    Some(x) => *x = w,
                    None if n < crate::lists::WAYPOINT_MAX as usize => ws.insert(0, w),
                    None => return false,
                }
                true
            }
            Op::DeleteWaypoint(i) => {
                let mut ws = self.waypoints.borrow_mut();
                (i as usize) < ws.len() && {
                    ws.remove(i as usize);
                    true
                }
            }
            Op::Dtmf(i, m) => self.dtmf.borrow_mut().get_mut(i as usize).map(|x| *x = (m, if m.is_some() { x.1 } else { Buf::new() })).is_some(),
            Op::DtmfName(i, n) => self.dtmf.borrow_mut().get_mut(i as usize).map(|x| x.1 = n).is_some(),
            Op::RenameZone(z, name) => self.zones.borrow_mut().get_mut(z as usize).map(|x| x.0 = name).is_some(),
            // CHAN-12: its channels go to no zone; the last zone goes away (as the sample store does it).
            Op::DeleteZone(z) => {
                if z as usize >= self.zones.borrow().len() {
                    return false;
                }
                self.chans.borrow_mut().values_mut().filter(|c| c.zone == z).for_each(|c| c.zone = NO_ZONE);
                let mut zs = self.zones.borrow_mut();
                if z as usize + 1 == zs.len() {
                    zs.pop();
                }
                true
            }
            // As the radio's store: a preset written whole keeps its skips; a new one is the next; deleting one
            // moves the ones after it up.
            Op::PutPreset(i, p) | Op::Preset(i, p) => {
                let mut ps = self.presets.borrow_mut();
                match (i as usize).cmp(&ps.len()) {
                    core::cmp::Ordering::Less => {
                        ps[i as usize] = RangePreset { skips: ps[i as usize].skips, ..p };
                        true
                    }
                    core::cmp::Ordering::Equal if ps.len() < 16 && matches!(op, Op::PutPreset(..)) => {
                        ps.push(RangePreset { skips: 0, ..p });
                        let mut sk = self.preset_skips.borrow_mut();
                        sk.resize(ps.len(), Vec::new());
                        sk[ps.len() - 1].clear();
                        true
                    }
                    _ => false,
                }
            }
            Op::DeletePreset(i) => {
                let mut ps = self.presets.borrow_mut();
                let mut sk = self.preset_skips.borrow_mut();
                if (i as usize) < sk.len() {
                    sk.remove(i as usize); // its list goes with it (LINK-58)
                }
                ((i as usize) < ps.len()).then(|| ps.remove(i as usize)).is_some()
            }
            Op::PresetSkips { preset, at, count, f } => {
                let mut ps = self.presets.borrow_mut();
                let Some(p) = ps.get_mut(preset as usize) else { return false };
                p.skips = count;
                let mut sk = self.preset_skips.borrow_mut();
                if sk.len() <= preset as usize {
                    sk.resize(preset as usize + 1, Vec::new());
                }
                let l = &mut sk[preset as usize];
                l.resize(count as usize, 0);
                for (j, v) in f.iter().enumerate().map(|(j, v)| (at as usize + j, *v)).filter(|(j, _)| *j < count as usize) {
                    l[j] = v;
                }
                true
            }
            _ => false,
        };
        self.bump();
        ok
    }
}

struct Out(Vec<u8>);

impl ferrite_app::term::Sink for Out {
    fn room(&self) -> usize {
        4096
    }
    fn put(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
}

/// Ferrite's radio side: its App and link session over a [`MemStore`], on the cable (trusted, LINK-7).
pub struct RadioSide {
    pub app: App,
    pub store: MemStore,
    link: Session,
    dev: Device,
    now: u32,
    seq: u8,
}

impl Default for RadioSide {
    fn default() -> Self {
        Self::new()
    }
}

impl RadioSide {
    /// A radio with the default settings and an empty store. The App borrows its settings for ever, as on the
    /// radio: each `RadioSide` leaks one settings record and one alert record (about a kilobyte).
    pub fn new() -> Self {
        let set = Box::leak(Box::new(Settings::DEFAULT));
        let alert = Box::leak(Box::new(AlertInfo::NONE));
        let mut app = App::new(set, alert);
        while app.pop_cmd().is_some() {}
        RadioSide {
            app,
            store: MemStore::default(),
            link: Session::new(true),
            dev: Device { tx_built: true, ..Device::default() },
            now: 1000,
            seq: 0,
        }
    }

    /// Wire bytes in (one or more whole frames, each ending 0x00); the answers' wire bytes.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Out(Vec::new());
        for &b in bytes {
            // The session takes a byte while it isn't holding a whole frame; it is answered at the delimiter.
            while !self.link.ready() {
                self.poll(&mut out);
            }
            self.link.feed(b, self.now);
            if b == 0 {
                self.poll(&mut out);
            }
        }
        out.0
    }

    fn poll(&mut self, out: &mut Out) {
        for _ in 0..8 {
            self.now = self.now.wrapping_add(5);
            self.link.poll(&mut self.app, &self.store, &self.dev, &LiveAll::default(), self.now, out);
            while let Some(w) = self.app.pop_write() {
                self.store.apply(w);
            }
            while self.app.pop_cmd().is_some() {}
            if self.link.ready() {
                return;
            }
        }
    }

    /// Events the session pushes now (LINK-46: a subscription's), each `EVENT`'s payload (kind first).
    pub fn events(&mut self) -> Vec<Vec<u8>> {
        let mut out = Out(Vec::new());
        for _ in 0..8 {
            self.now = self.now.wrapping_add(50);
            self.link.events(&mut self.app, &self.store, &self.dev, &LiveAll::default(), self.now, None, &mut out);
        }
        out.0
            .split(|&b| b == 0)
            .filter(|f| !f.is_empty())
            .filter_map(|f| {
                let mut f = f.to_vec();
                link::parse(&mut f).ok().map(|p| p.payload.to_vec())
            })
            .collect()
    }

    /// One request in process (no wire): its status and the rest of the answer.
    pub fn ask(&mut self, ty: u8, payload: &[u8]) -> (u8, Vec<u8>) {
        self.seq = self.seq.wrapping_add(1);
        let mut w = [0u8; MAX_WIRE];
        let Some(n) = link::build(ty, self.seq, payload, &mut w) else {
            return (link::Status::BadArg as u8, Vec::new());
        };
        let mut a = self.feed(&w[..n]);
        let Some(k) = a.iter().position(|&b| b == 0) else { return (0xFF, Vec::new()) };
        match link::parse(&mut a[..k]) {
            Ok(f) if !f.payload.is_empty() => (f.payload[0], f.payload[1..].to_vec()),
            _ => (0xFF, Vec::new()),
        }
    }

    /// One channel or zone record by `READ_MANY` (LINK-40: they aren't read one at a time any more): its bytes, or
    /// the status (`NotFound` when there is none at that index).
    pub fn read_one(&mut self, w: u8, idx: u16) -> Result<Vec<u8>, u8> {
        let mut p = vec![w];
        p.extend(idx.to_le_bytes());
        p.extend(1u16.to_le_bytes());
        let (s, rest) = self.ask(link::msg::READ_MANY, &p);
        if s != 0 {
            return Err(s);
        }
        let r = &rest[2..];
        if r.len() < 3 || u16::from_le_bytes([r[0], r[1]]) != idx {
            return Err(link::Status::NotFound as u8);
        }
        Ok(r[3..3 + r[2] as usize].to_vec())
    }

    /// One channel or zone record by `WRITE_MANY` (LINK-41): the status and, for a refusal, its reason (the
    /// applied count taken off).
    pub fn write_one(&mut self, w: u8, idx: u16, rec: &[u8]) -> (u8, Vec<u8>) {
        let mut p = vec![w];
        p.extend(idx.to_le_bytes());
        p.push(rec.len() as u8);
        p.extend_from_slice(rec);
        let (s, rest) = self.ask(link::msg::WRITE_MANY, &p);
        let counted = s == 0 || s == link::Status::Invalid as u8 || rest.len() == 1;
        (s, if counted && !rest.is_empty() { rest[1..].to_vec() } else { rest })
    }

    /// Puts range presets straight into the store (a radio's starting state), bypassing the link's checks.
    pub fn seed_presets(&mut self, presets: &[RangePreset]) {
        *self.store.presets.borrow_mut() = presets.iter().take(16).copied().collect();
        *self.store.preset_skips.borrow_mut() = vec![Vec::new(); presets.len().min(16)];
        self.store.bump();
    }

    /// Puts zones and channels straight into the store (a radio's starting state), bypassing the link's checks.
    pub fn seed(&mut self, zones: &[(Name, ZoneCfg)], chans: &[Channel]) {
        *self.store.zones.borrow_mut() = zones.to_vec();
        *self.store.chans.borrow_mut() = chans.iter().filter(|c| c.num < MAX_CHANNELS).map(|c| (c.num, *c)).collect();
        self.store.bump();
    }
}
