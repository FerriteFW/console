//! LINK-13.4: receive audio from the radio over the cable, 12 kHz G.711 µ-law (decision 330). Each `AUDIO_DATA`
//! block decodes on its own, with ferrite's own coder (`ferrite_core::rxaudio`), so the radio and Console can't
//! disagree on the format.

use ferrite_core::rxaudio;

/// One `AUDIO_DATA` payload's samples (12 kHz, 16-bit); empty for a keep-alive or a malformed block.
pub fn decode(p: &[u8]) -> Vec<i16> {
    let Some((_, _, _, codes)) = rxaudio::get(p) else { return Vec::new() };
    codes.iter().map(|&u| rxaudio::ulaw_decode(u)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferrite_core::rxaudio::{Packer, BLOCK, NO_SLOT, SQ_OPEN};

    /// LINK-13.4: a block the radio's packer made decodes here to its 192 samples, keep-alives to none.
    #[test]
    fn blocks_from_the_radio_decode() {
        let mut p = Packer::new();
        let mut blocks = Vec::new();
        for i in 0..24_000 {
            let x = (8000.0 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / 24_000.0).sin()) as i16;
            p.push(x, |b| blocks.push(*b));
        }
        assert_eq!(blocks.len(), 12_000 / BLOCK);
        let mut w = [0u8; 240];
        let n = rxaudio::put(7, 1, SQ_OPEN, Some(&blocks[20]), &mut w);
        let s = decode(&w[..n]);
        assert_eq!(s.len(), BLOCK);
        let peak = s.iter().map(|&x| (x as i32).abs()).max().unwrap();
        assert!((7000..=8400).contains(&peak), "the tone's level: {peak}");
        let n = rxaudio::put(8, NO_SLOT, 0, None, &mut w);
        assert!(decode(&w[..n]).is_empty());
        assert!(decode(&[1, 2]).is_empty());
    }
}
