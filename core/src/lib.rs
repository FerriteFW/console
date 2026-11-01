//! # ferrite-console-core
//!
//! Ferrite Console's protocol core, the PC side of Ferrite's link protocol (manual chapter 29, Appendix "Link
//! protocol v1"). It mirrors `ferrite/tools/ferrite_link.py`, the reference client, and reuses ferrite's own code
//! for everything the radio and the PC must agree on: the frame codec, message and status numbers
//! (`ferrite_core::link`), the key codes (`ferrite_core::keys`) and the unique ID's text (`ferrite_core::uid`).
//!
//! It is sans-I/O: [`session::Session`] turns requests into wire bytes and wire bytes into answers, and the caller
//! moves the bytes (Web Serial and Web Bluetooth in the browser through the `wasm` crate; native transports in the
//! Tauri app later). Time comes in as milliseconds from the caller, so the same code runs everywhere.
//!
//! - [`session`]: framing, sequence numbers, the cable's sync byte, answer matching.
//! - [`answers`]: `HELLO`, `INFO`, `SLOT` and text (`UI`, `CMD`, `MORE`) answers; status names; the build byte.
//! - [`ui`]: the UI readback's lines (LINK-19) as a structure the Live View draws.
//! - [`keys`]: key names to stock key codes, `KEY` and knob payloads (never PTT).
//! - [`uid`]: the unique ID as About shows it.
//! - [`records`]: `READ`/`WRITE`/`DELETE`/`BEGIN`/`END` payloads, for channel and zone programming (phase 2).
//! - [`presets`]: range presets (MENU 0 1 4) over the link, their checks and write plan.
//! - [`library`]: the "Add channels" library: fixed sets, airports and TAFL sites near a place, as channels.
//! - [`settings`]: the radio-wide settings record as the menu shows it (Radio Settings).
//! - [`aprs`]: the heard list, messages, sending one, and the events a subscription brings (LINK-44 – LINK-46).
//! - [`aprs_settings`]: the APRS record as MENU 0 5 shows it (LINK-43), changed and checked as the settings are.
//! - [`log`]: the event log (`LOG_READ`, LINK-42) for the Activity Log.
//! - [`lists`]: the quick messages, waypoints and DTMF memories over the link (LINK-54 – LINK-56).
//! - [`liveview`]: Live View from the radio's compact UI events (LINK-47, LINK-48), for Bluetooth.
//! - [`migrate`]: an update's move of the radio's data to another SPI flash layout (LINK-59 – LINK-62): the PC's
//!   copy, layout 2 to 3, and the raw writes in their safe order.
//! - [`firmware`]: Firmware Update: the `.btf` checks and the stock bootloader's frames (tools/btf.py, flash.py).
//! - [`install`]: the Install page: the reader backup (fdump), the SSB patch, back to stock (`STOCK_RESTORE`).
//! - [`signature`]: release images' minisign signatures, checked with Ferrite's public key.
//! - [`demo`]: a demo radio answering from memory, for trying Console without a radio.
//! - [`timing`]: the reference client's time-outs and pacing, in one place.
//! - [`zonecap`]: a zone holds 256 channels at most (CHAN-35): the counts, the refusal, and splitting a long list.

pub mod answers;
pub mod aprs;
pub mod audio;
pub mod aprs_settings;
pub mod channels;
pub mod chirp;
pub mod crossband;
#[cfg(test)]
mod codeplug_example;
pub mod demo;
pub mod firmware;
pub mod install;
pub mod keys;
pub mod library;
pub mod lists;
pub mod liveview;
pub mod log;
pub mod migrate;
pub mod plan;
pub mod presets;
pub mod radioside;
pub mod records;
pub mod session;
pub mod settings;
pub mod signature;
pub mod timing;
pub mod ui;
pub mod uid;
pub mod zonecap;

/// The protocol numbers, re-exported from ferrite so callers don't need a second dependency.
pub use ferrite_core::link;
