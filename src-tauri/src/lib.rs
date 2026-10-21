//! Ferrite Console's desktop shell (Tauri 2; iOS and Android later on the same base). The UI is the web build's,
//! and the protocol runs in it (the core as wasm), so the shell only has to move bytes for the platforms whose
//! webview has no Web Serial or Web Bluetooth (WKWebView on macOS and iOS, WebKitGTK on Linux, Android's WebView).
//!
//! The transport commands are the seam (src/lib/transport/native.ts calls them):
//! - `transport_open(kind)`: "cable" or "bluetooth"; picks and opens a device.
//! - `transport_write(bytes)`: writes bytes (Bluetooth: 20-byte writes 25 ms apart, FFE1 only, never FF31).
//! - `transport_close()`.
//! - received bytes go to the webview as `transport://data` events, a drop as `transport://closed`.
//!
//! TODO(native transports): serial through the `serialport` crate (115200 8N1, then the BAUD rates), BLE through
//! `btleplug` (service FFE0, characteristic FFE1). Until then every command answers "not implemented yet" and the
//! desktop app offers the demo radio.

const NOT_YET: &str = "Native cable and Bluetooth aren't in the desktop app yet: use Chrome (the web build) for a radio, or the demo radio here.";

#[tauri::command]
fn transport_open(kind: String) -> Result<(), String> {
    let _ = kind;
    Err(NOT_YET.into())
}

#[tauri::command]
fn transport_write(bytes: Vec<u8>) -> Result<(), String> {
    let _ = bytes;
    Err(NOT_YET.into())
}

#[tauri::command]
fn transport_close() -> Result<(), String> {
    Ok(())
}

/// The core's protocol version, so the shell is known to link the same core the web build runs.
#[tauri::command]
fn core_protocol() -> u8 {
    ferrite_console_core::link::PROTOCOL
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![transport_open, transport_write, transport_close, core_protocol])
        .run(tauri::generate_context!())
        .expect("error while running Ferrite Console");
}
