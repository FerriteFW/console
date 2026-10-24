//! Time-outs and pacing, as `ferrite_link.py` uses them. All in milliseconds.

use serde::Serialize;

/// Ctrl-C (closes the radio's terminal if it holds the cable, TERM-2), then this long before the 0x00 that gives
/// the cable to the link; what arrives meanwhile (the terminal's goodbye) is dropped.
pub const OPEN_SETTLE_MS: u32 = 300;
/// A request sent after this much quiet gets a 0x00 sync first: the radio lets the cable go 10 s after the last
/// frame (TERM-2), and in auto a frame's bytes would go to the terminal.
pub const QUIET_MS: u32 = 5_000;
/// How long to wait for an answer on the cable.
pub const CABLE_TIMEOUT_MS: u32 = 2_000;
/// How long to wait on Bluetooth (paced at ~280 B/s by the radio, LINK-36: a 224-byte chunk takes ~0.8 s).
pub const BLE_TIMEOUT_MS: u32 = 6_000;
/// `busy` answers (a long press still held, the store writing) are asked again for this long...
pub const BUSY_RETRY_MS: u32 = 3_000;
/// ...this far apart.
pub const BUSY_SLEEP_MS: u32 = 50;
/// A long press: the radio lets it go 750 ms after its answer ([`ferrite_core::link::key::LONG_HOLD_MS`]); the
/// client waits that plus 50 ms before the next request.
pub const LONG_SETTLE_MS: u32 = ferrite_core::link::key::LONG_HOLD_MS + 50;
/// `CMD`/`MORE` answered "more follows" with no text: the radio is still working, ask again after this.
pub const MORE_WAIT_MS: u32 = 50;
/// Bluetooth writes: FFE1 takes 20 bytes a write (the default MTU's ATT payload)...
pub const BLE_CHUNK: usize = 20;
/// ...25 ms apart (800 B/s, under the module's 9600-baud UART).
pub const BLE_PACE_MS: u32 = 25;
/// After `BAUD`'s answer, switch the port's rate this much later, then `HELLO` at the new rate within 1 s
/// (LINK-11) or the radio goes back to 115200.
pub const BAUD_SWITCH_MS: u32 = 50;
/// The radio falls back to 115200 this long after a `BAUD` with no `HELLO` at the new rate (LINK-11).
pub const BAUD_FALLBACK_MS: u32 = 1_000;
/// The cable's resting rate.
pub const CABLE_BAUD: u32 = 115_200;
/// The rates Console tries on the cable, best first (LINK-13.3, ferrite decision 266); 115200 if it doesn't answer.
/// 230400 only: long transfers at 460800 lost bytes through a USB extension (Alex, Oct 23, 2026), and 230400 is the
/// one safe rate for everything over the cable. The radio still takes 460800 (LINK-11) for other hosts.
pub const CABLE_FAST_RATES: [u32; 1] = [230_400];
/// A long press on the drawn keypad: held this long, it is sent as a long press (the radio's own is 700 ms,
/// KEY-3; remote long presses hold 750 ms).
pub const HOLD_FOR_LONG_MS: u32 = 750;

/// All of the above, for the UI layer.
#[derive(Clone, Debug, Serialize)]
pub struct Timing {
    pub open_settle_ms: u32,
    pub quiet_ms: u32,
    pub cable_timeout_ms: u32,
    pub ble_timeout_ms: u32,
    pub busy_retry_ms: u32,
    pub busy_sleep_ms: u32,
    pub long_settle_ms: u32,
    pub more_wait_ms: u32,
    pub ble_chunk: usize,
    pub ble_pace_ms: u32,
    pub baud_switch_ms: u32,
    pub baud_fallback_ms: u32,
    pub cable_baud: u32,
    pub cable_fast_rates: [u32; 1],
    pub hold_for_long_ms: u32,
}

pub const TIMING: Timing = Timing {
    open_settle_ms: OPEN_SETTLE_MS,
    quiet_ms: QUIET_MS,
    cable_timeout_ms: CABLE_TIMEOUT_MS,
    ble_timeout_ms: BLE_TIMEOUT_MS,
    busy_retry_ms: BUSY_RETRY_MS,
    busy_sleep_ms: BUSY_SLEEP_MS,
    long_settle_ms: LONG_SETTLE_MS,
    more_wait_ms: MORE_WAIT_MS,
    ble_chunk: BLE_CHUNK,
    ble_pace_ms: BLE_PACE_MS,
    baud_switch_ms: BAUD_SWITCH_MS,
    baud_fallback_ms: BAUD_FALLBACK_MS,
    cable_baud: CABLE_BAUD,
    cable_fast_rates: CABLE_FAST_RATES,
    hold_for_long_ms: HOLD_FOR_LONG_MS,
};

#[cfg(test)]
mod tests {
    use super::*;
    use ferrite_core::link::RATES;

    /// LINK-13.3: the rates tried are ones the radio takes (LINK-11).
    #[test]
    fn fast_rates_are_link_rates() {
        for r in CABLE_FAST_RATES {
            assert!(RATES.contains(&r));
        }
        assert_eq!(RATES[0], CABLE_BAUD);
        assert_eq!(LONG_SETTLE_MS, 800, "ferrite_link.py: LONG_HOLD + 0.05 s");
    }
}
