//! The unique ID as About shows it (SELF-8, LINK-35.1): `INFO`'s last 12 bytes through ferrite's own base32
//! ([`ferrite_core::uid::text`]), in groups of five, as `ferrite_link.py`'s `uid_text`.

/// The 12 bytes (each MCU word little-endian, lowest first) as "XXXXX XXXXX XXXXX XXXXX"; None when the length is
/// wrong (older firmware) or the bytes are all zero (not read yet).
pub fn text(b: &[u8]) -> Option<String> {
    if b.len() != 12 || b.iter().all(|&x| x == 0) {
        return None;
    }
    let w = |i: usize| u32::from_le_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]);
    let t = ferrite_core::uid::text([w(0), w(1), w(2)]);
    let groups: Vec<&str> = t.chunks(5).map(|g| core::str::from_utf8(g).unwrap_or("?????")).collect();
    Some(groups.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ferrite_link.py`'s uid_text, transcribed: the bytes as one big-endian number, shifted 4, 20 digits.
    fn python_uid_text(b: &[u8]) -> String {
        let digits = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        let n = b.iter().fold(0u128, |n, &x| n << 8 | x as u128) << 4;
        let t: String = (0..20).map(|i| digits[(n >> (5 * (19 - i)) & 31) as usize] as char).collect();
        (0..4).map(|i| &t[5 * i..5 * i + 5]).collect::<Vec<_>>().join(" ")
    }

    /// SELF-8, LINK-35.1: the same text as ferrite_link.py and the radio's About page.
    #[test]
    fn matches_ferrite_link_py() {
        let cases: [[u8; 12]; 4] = [
            ferrite_core::uid::bytes([0x3F2A_91C0, 0x7D44_0123, 0x89AB_CDEF]),
            [0xFF; 12],
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80],
        ];
        for b in cases {
            let t = text(&b).unwrap();
            assert_eq!(t, python_uid_text(&b), "{b:02X?}");
            assert_eq!(t.len(), 23);
        }
        assert_eq!(text(&[0xFF; 12]).unwrap(), "ZZZZZ ZZZZZ ZZZZZ ZZZZG");
        assert_eq!(text(&[0; 12]), None, "not read yet");
        assert_eq!(text(&[1; 11]), None, "older firmware");
    }
}
