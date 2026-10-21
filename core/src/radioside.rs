//! Ferrite's own radio side of the link, in memory: ferrite-app's `App` and `link::Session` (the code the radio
//! runs) over a channel store kept here ([`MemStore`]: 1,000 channels, 254 zones, like the radio's). The demo radio
//! answers records through it, and [`crate::plan`] dry-runs a write through it before anything goes to a radio,
//! so every check and refusal is the firmware's own, never a copy.

use ferrite_app::chan::{ChanWrite, Channel, ChannelStore, Name, MAX_CHANNELS, NO_ZONE};
use ferrite_app::data::{Data, Op, ZoneCfg};
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
            ChanWrite::PutPos { ch, .. } => {
                c.insert(ch.num, ch);
            }
            ChanWrite::Delete(n) => {
                c.remove(&n);
            }
            ChanWrite::DeleteZone(z) => c.values_mut().filter(|x| x.zone == z).for_each(|x| x.zone = NO_ZONE),
            ChanWrite::EraseAll => c.clear(),
        }
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

    /// Puts zones and channels straight into the store (a radio's starting state), bypassing the link's checks.
    pub fn seed(&mut self, zones: &[(Name, ZoneCfg)], chans: &[Channel]) {
        *self.store.zones.borrow_mut() = zones.to_vec();
        *self.store.chans.borrow_mut() = chans.iter().filter(|c| c.num < MAX_CHANNELS).map(|c| (c.num, *c)).collect();
        self.store.bump();
    }
}
