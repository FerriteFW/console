//! The World Magnetic Model WMM2025 (SAT-18): the magnetic declination at a place, for the satellite pointing page's
//! compass bearing. Console works it out at the radio's position and writes it with the satellites (LINK-64); the
//! radio keeps no model of its own.
//!
//! The coefficients are NOAA's `WMM.COF` for WMM2025 (epoch 2025.0, valid to 2030.0), copied unchanged into
//! `wmm/WMM2025.COF` from `WMM2025COF.zip` at <https://www.ncei.noaa.gov/products/world-magnetic-model> (NCEI and the
//! British Geological Survey; a work of the US government, public domain). `wmm/WMM2025_TestValues.txt` is NOAA's
//! published test table from the same page (`WMM2025_TestValues.txt`, its comment header dropped); the tests check
//! every row of it.
//!
//! The model: spherical harmonics to degree and order 12 with Schmidt semi-normalized associated Legendre
//! functions, the main field plus the secular variation times the years since 2025.0, at the geocentric position of
//! a WGS 84 geodetic one, the field turned back to the geodetic frame. As in NOAA's report (NOAA Technical Report
//! "The US/UK World Magnetic Model for 2025-2030", section 1.2), in f64.

/// The model's degree and order.
const N: usize = 12;
/// The model's epoch, a decimal year.
pub const EPOCH: f64 = 2025.0;
/// The model is valid to here (a later date is still worked out: the declination drifts slowly).
pub const VALID_TO: f64 = 2030.0;
/// The geomagnetic reference radius (km).
const A_REF: f64 = 6371.2;
/// WGS 84: semi-major axis (km) and flattening.
const WGS_A: f64 = 6378.137;
const WGS_F: f64 = 1.0 / 298.257_223_563;

const COF: &str = include_str!("wmm/WMM2025.COF");

/// The field at a place: north, east and down components (nT), as NOAA's tables give them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Field {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Field {
    /// The declination: degrees east of true north (west negative).
    pub fn declination(&self) -> f64 {
        self.y.atan2(self.x).to_degrees()
    }
    /// The inclination (dip): degrees below the horizontal.
    pub fn inclination(&self) -> f64 {
        self.z.atan2(self.x.hypot(self.y)).to_degrees()
    }
    /// The horizontal intensity (nT).
    pub fn h(&self) -> f64 {
        self.x.hypot(self.y)
    }
}

/// The coefficients (g, h, and their yearly change), indexed [n][m].
struct Coefs {
    g: [[f64; N + 1]; N + 1],
    h: [[f64; N + 1]; N + 1],
    gd: [[f64; N + 1]; N + 1],
    hd: [[f64; N + 1]; N + 1],
}

fn coefs() -> Coefs {
    let mut c = Coefs {
        g: [[0.0; N + 1]; N + 1],
        h: [[0.0; N + 1]; N + 1],
        gd: [[0.0; N + 1]; N + 1],
        hd: [[0.0; N + 1]; N + 1],
    };
    for line in COF.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 6 {
            continue;
        }
        let (Ok(n), Ok(m)) = (f[0].parse::<usize>(), f[1].parse::<usize>()) else { continue };
        if n == 0 || n > N || m > n {
            continue;
        }
        let v: Vec<f64> = f[2..6].iter().map(|s| s.parse().unwrap_or(0.0)).collect();
        (c.g[n][m], c.h[n][m], c.gd[n][m], c.hd[n][m]) = (v[0], v[1], v[2], v[3]);
    }
    c
}

/// The field at a geodetic latitude and longitude (degrees, north and east positive), a height above the WGS 84
/// ellipsoid (km) and a decimal year.
pub fn field(lat: f64, lon: f64, height_km: f64, year: f64) -> Field {
    let c = coefs();
    let dt = year - EPOCH;
    // Geodetic to geocentric spherical.
    let (sl, cl) = lat.to_radians().sin_cos();
    let e2 = WGS_F * (2.0 - WGS_F);
    let rc = WGS_A / (1.0 - e2 * sl * sl).sqrt();
    let xp = (rc + height_km) * cl;
    let zp = (rc * (1.0 - e2) + height_km) * sl;
    let r = xp.hypot(zp);
    let phig = (zp / r).asin(); // geocentric latitude
                                // Colatitude's cosine and sine.
    let (ct, st) = phig.sin_cos();
    let st = st.max(1e-12); // at a pole: no longitude, the east component's 1/sin kept finite
    let lam = lon.to_radians();

    // Schmidt semi-normalized P(n,m)(cos theta) and dP/dtheta: Gauss-normalized recursion, then the Schmidt factors.
    let mut p = [[0.0f64; N + 1]; N + 1];
    let mut dp = [[0.0f64; N + 1]; N + 1];
    p[0][0] = 1.0;
    for n in 1..=N {
        for m in 0..=n {
            if n == m {
                p[n][m] = st * p[n - 1][m - 1];
                dp[n][m] = st * dp[n - 1][m - 1] + ct * p[n - 1][m - 1];
            } else {
                let k = if n == 1 {
                    0.0
                } else {
                    (((n - 1) * (n - 1)) as f64 - (m * m) as f64) / (((2 * n - 1) * (2 * n - 3)) as f64)
                };
                let (p2, dp2) = if n >= 2 { (p[n - 2][m], dp[n - 2][m]) } else { (0.0, 0.0) };
                p[n][m] = ct * p[n - 1][m] - k * p2;
                dp[n][m] = ct * dp[n - 1][m] - st * p[n - 1][m] - k * dp2;
            }
        }
    }
    let mut s = [[0.0f64; N + 1]; N + 1];
    s[0][0] = 1.0;
    for n in 1..=N {
        s[n][0] = s[n - 1][0] * (2 * n - 1) as f64 / n as f64;
        for m in 1..=n {
            let j = if m == 1 { 2.0 } else { 1.0 };
            s[n][m] = s[n][m - 1] * (((n - m + 1) as f64 * j) / (n + m) as f64).sqrt();
        }
    }

    // B = -grad V, V = a sum (a/r)^(n+1) sum (g cos m lam + h sin m lam) P(n,m).
    let ar = A_REF / r;
    let (mut bx, mut by, mut bz) = (0.0, 0.0, 0.0);
    let mut arn = ar * ar; // (a/r)^(n+2) from n = 0
    for n in 1..=N {
        arn *= ar;
        for m in 0..=n {
            let g = (c.g[n][m] + dt * c.gd[n][m]) * s[n][m];
            let h = (c.h[n][m] + dt * c.hd[n][m]) * s[n][m];
            let (sm, cm) = (m as f64 * lam).sin_cos();
            let t = g * cm + h * sm;
            bx += arn * t * dp[n][m]; // north: -B_theta
            by += arn * m as f64 * (g * sm - h * cm) * p[n][m]; // east, before / sin theta
            bz -= arn * (n + 1) as f64 * t * p[n][m]; // down: -B_r
        }
    }
    by /= st;
    // The geocentric frame turned to the geodetic one.
    let psi = phig - lat.to_radians();
    let (sp, cp) = psi.sin_cos();
    Field { x: bx * cp - bz * sp, y: by, z: bx * sp + bz * cp }
}

/// The declination at a place on the ground at a decimal year, in tenths of a degree, east positive (SAT-18,
/// LINK-64's record).
pub fn declination_tenths(lat: f64, lon: f64, year: f64) -> i16 {
    (field(lat, lon, 0.0, year).declination() * 10.0).round().clamp(-1800.0, 1800.0) as i16
}

/// UTC seconds since 1970 as a decimal year (for the secular variation: a day either way is nothing).
pub fn decimal_year(unix: f64) -> f64 {
    let days = unix / 86_400.0;
    // Days from 1970 to Jan 1 of each year until past `days`.
    let mut y = 1970i32;
    let mut start = 0.0;
    loop {
        let len = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 366.0 } else { 365.0 };
        if days < start + len {
            return y as f64 + (days - start) / len;
        }
        start += len;
        y += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SAT-18: every row of NOAA's WMM2025 test table (100 places from 2025.0 to 2029.5, heights 0-100 km):
    /// the declination within 0.01° (the table gives two decimals), the components within 1 nT.
    #[test]
    fn noaa_test_values() {
        let rows: Vec<Vec<f64>> = include_str!("wmm/WMM2025_TestValues.txt")
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.split_whitespace().map(|v| v.parse().unwrap()).collect())
            .collect();
        assert_eq!(rows.len(), 100);
        for r in &rows {
            let (year, h, lat, lon) = (r[0], r[1], r[2], r[3]);
            let f = field(lat, lon, h, year);
            let at = format!("{year} {h} km {lat},{lon}");
            assert!((f.declination() - r[4]).abs() <= 0.0051, "{at}: declination {} vs {}", f.declination(), r[4]);
            assert!((f.inclination() - r[5]).abs() <= 0.0051, "{at}: inclination {} vs {}", f.inclination(), r[5]);
            assert!(
                (f.x - r[7]).abs() < 1.0 && (f.y - r[8]).abs() < 1.0 && (f.z - r[9]).abs() < 1.0,
                "{at}: {f:?} vs {:?}",
                &r[7..10]
            );
        }
    }

    /// SAT-18: tenths of a degree, east positive: the first row (89° N, 121° W: -99.77°) and Vancouver (about 15.5° E).
    #[test]
    fn tenths() {
        assert_eq!(field(89.0, -121.0, 28.0, 2025.0).declination().mul_add(10.0, 0.0).round() as i16, -998);
        let v = declination_tenths(49.28, -123.12, 2026.83);
        assert!((145..=165).contains(&v), "{v}");
        assert!((decimal_year(1_793_491_200.0) - 2026.8329).abs() < 0.001, "2026-11-01");
        assert!((decimal_year(1_735_689_600.0) - 2025.0).abs() < 1e-9, "2025-01-01");
    }
}
