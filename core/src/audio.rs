//! LINK-13.4: receive audio from the radio over the cable. Each `AUDIO_DATA` block decodes on its own (it carries
//! the coder's state at its start), with ferrite's own coder (`ferrite_core::rxaudio`), so the radio and Console
//! can't disagree on the format.

use ferrite_core::rxaudio;

/// One `AUDIO_DATA` payload's samples (8 kHz, 16-bit); empty for a keep-alive or a malformed block.
pub fn decode(p: &[u8]) -> Vec<i16> {
    let Some((_, _, _, start, codes)) = rxaudio::get(p) else { return Vec::new() };
    let mut out = vec![0i16; codes.len() * 2];
    let n = rxaudio::decode(start, codes, &mut out);
    out.truncate(n);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferrite_core::rxaudio::{Packer, BLOCK, NO_SLOT, SQ_OPEN};

    /// LINK-13.4: a block the radio's packer made decodes here to its 256 samples, keep-alives to none.
    #[test]
    fn blocks_from_the_radio_decode() {
        let mut p = Packer::new();
        let mut blocks = Vec::new();
        for i in 0..24_000 {
            let x = (8000.0 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / 24_000.0).sin()) as i16;
            p.push(x, |b| blocks.push(*b));
        }
        let mut w = [0u8; 200];
        let n = rxaudio::put(7, 1, SQ_OPEN, Some(&blocks[20]), &mut w);
        let s = decode(&w[..n]);
        assert_eq!(s.len(), BLOCK);
        assert!(s.iter().map(|&x| (x as i32).abs()).max().unwrap() > 6000, "the tone's level");
        let n = rxaudio::put(8, NO_SLOT, 0, None, &mut w);
        assert!(decode(&w[..n]).is_empty());
        assert!(decode(&[1, 2]).is_empty());
    }
}
