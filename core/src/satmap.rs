//! A satellite on Console's map (Satellites page; SAT-23, decision 395): where it is now, its ground track for the
//! next two orbits, the area that can hear it, and the next pass over a place. From the same record the radio holds,
//! with the radio's own SGP4 and look angles (`ferrite_core::sat`), so the map and the radio agree.

use ferrite_core::sat::look::{gmst, Observer};
use ferrite_core::sat::sgp4::Sgp4;
use ferrite_core::sat::wire;
use serde::Serialize;

/// The equatorial radius (km), as the radio's look angles use it.
const R_EARTH: f32 = 6378.137;
/// The ground track's step and the pass search's.
const TRACK_STEP_S: u32 = 30;
const PASS_STEP_S: u32 = 20;
/// How far ahead a pass is looked for.
const PASS_HORIZON_S: u32 = 2 * 86_400;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Point {
    pub lat: f32,
    pub lon: f32,
}

/// A pass over the place: rise and set (UTC seconds, to the search step), and the highest elevation (degrees).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Pass {
    pub aos: u32,
    pub los: u32,
    pub max_el: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SatMap {
    /// Under the satellite now, and its height (km).
    pub now: Point,
    pub alt_km: f32,
    /// The radius (km, along the ground) of the area that sees it above the horizon now.
    pub footprint_km: f32,
    /// The ground track from now for two orbits, split where it crosses the date line (one polyline each).
    pub track: Vec<Vec<Point>>,
    /// The pass under way or the next one within two days, when a place is given.
    pub next: Option<Pass>,
}

/// The point under a TEME position at `unix` (geocentric latitude: close enough for a map), and the height.
fn under(r: [f32; 3], unix: u32) -> (Point, f32) {
    let lon = (r[1].atan2(r[0]) - gmst(unix)).to_degrees();
    let lon = (lon + 540.0).rem_euclid(360.0) - 180.0;
    let rxy = (r[0] * r[0] + r[1] * r[1]).sqrt();
    let lat = r[2].atan2(rxy).to_degrees();
    let alt = (rxy * rxy + r[2] * r[2]).sqrt() - R_EARTH;
    (Point { lat, lon }, alt)
}

/// The map for the satellite in `record` (the radio's satellite record, SAT-2) at `now`, and the next pass over
/// `place` (latitude and longitude in degrees) when one is given.
pub fn sat_map(record: &[u8], now: u32, place: Option<(f64, f64)>) -> Result<SatMap, String> {
    let sat = wire::decode(record).map_err(|e| e.to_string())?;
    let sgp = Sgp4::new(&sat.el).map_err(|e| format!("{e:?}"))?;
    let epoch = sat.el.epoch_unix();
    let at = |t: u32| sgp.at(t as i32 - epoch as i32).ok();
    let state = at(now).ok_or("the orbit has decayed by now")?;
    let (here, alt) = under(state.r, now);
    let footprint_km = R_EARTH * (R_EARTH / (R_EARTH + alt.max(0.0))).acos();
    // two orbits: the period from the mean motion (radians a minute)
    let period_s = (core::f32::consts::TAU / sat.el.n_rad_min() * 60.0) as u32;
    let mut track: Vec<Vec<Point>> = vec![Vec::new()];
    let mut last: Option<Point> = None;
    let mut t = now;
    while t <= now + 2 * period_s.clamp(60, 86_400) {
        let Some(s) = at(t) else { break };
        let (p, _) = under(s.r, t);
        if last.is_some_and(|l| (p.lon - l.lon).abs() > 180.0) {
            track.push(Vec::new()); // across the date line: a new line, not one across the whole map
        }
        track.last_mut().expect("never empty").push(p);
        last = Some(p);
        t += TRACK_STEP_S;
    }
    let next = place.and_then(|(lat, lon)| {
        let obs = Observer::new((lat * 1e7) as i32, (lon * 1e7) as i32, 0);
        let el = |t: u32| at(t).map(|s| obs.look(&s, t).el);
        let mut t = now;
        // under way now: back to its rise, at most the search horizon's step count
        if el(now)? > 0.0 {
            while t > now.saturating_sub(3600) && el(t - PASS_STEP_S).is_some_and(|e| e > 0.0) {
                t -= PASS_STEP_S;
            }
        } else {
            while t < now + PASS_HORIZON_S && el(t).is_some_and(|e| e <= 0.0) {
                t += PASS_STEP_S;
            }
            if t >= now + PASS_HORIZON_S {
                return None;
            }
        }
        let aos = t;
        let mut max_el = f32::MIN;
        while let Some(e) = el(t).filter(|&e| e > 0.0) {
            max_el = max_el.max(e);
            t += PASS_STEP_S;
        }
        Some(Pass { aos, los: t, max_el })
    });
    Ok(SatMap { now: here, alt_km: alt, footprint_km, track, next })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferrite_core::sat::{Elements, Sat, F32};

    /// The ISS-like orbit the radio's own tests use: 51.6°, about 15.5 revolutions a day.
    fn iss(epoch_unix: u32) -> Vec<u8> {
        let el = Elements {
            epoch: epoch_unix - 946_684_800, // seconds since 2000-01-01
            epoch_ms: 0,
            incl: 516_400_000, // 51.64°, in 1e-7 degree
            raan: 1_000_000_000,
            argp: 900_000_000,
            ma: 300_000_000,
            ecc: 5_000,                // 0.0005
            n: 1_550_000_000,          // 15.5 revolutions a day, in 1e-8
            bstar: F32::new(0.0001),
        };
        let mut s = Sat { id: 25544, el, ..Default::default() };
        s.name[..3].copy_from_slice(b"ISS");
        wire::encode(&s).to_vec()
    }

    /// SAT-23: under the satellite within its inclination, about 400 km up, a footprint of a couple of thousand km,
    /// a track of two orbits in date-line-split pieces, and a pass over a place within two days.
    #[test]
    fn iss_on_the_map() {
        let now = 1_794_600_000;
        let m = sat_map(&iss(now - 3600), now, Some((49.25, -123.1))).unwrap();
        assert!(m.now.lat.abs() <= 52.0, "{:?}", m.now);
        assert!((300.0..600.0).contains(&m.alt_km), "{}", m.alt_km);
        assert!((1500.0..3000.0).contains(&m.footprint_km), "{}", m.footprint_km);
        let points: usize = m.track.iter().map(Vec::len).sum();
        assert!(points > 300 && m.track.len() >= 2, "{} points in {} pieces", points, m.track.len());
        for piece in &m.track {
            for w in piece.windows(2) {
                assert!((w[1].lon - w[0].lon).abs() < 180.0, "a piece never jumps the date line");
            }
        }
        let p = m.next.expect("an ISS pass over Vancouver within two days");
        assert!(p.aos >= now - 3600 && p.los > p.aos && p.los - p.aos < 1200 && p.max_el > 0.0, "{p:?}");
        assert!(sat_map(&iss(now - 3600), now, None).unwrap().next.is_none());
        assert!(sat_map(&[0u8; 3], now, None).is_err());
    }
}
