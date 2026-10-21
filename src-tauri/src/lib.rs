//! Ferrite Console's desktop shell (Tauri 2; iOS and Android later on the same base). The UI is the web build's,
//! and the protocol runs in it (the core as wasm), so the shell only moves bytes for the webviews that have no Web
//! Serial or Web Bluetooth (WKWebView on macOS, WebKitGTK on Linux).
//!
//! The commands src/lib/transport/native.ts calls:
//! - `serial_ports()`: the ports for the picker. `ble_scan_start()`, `ble_devices()`, `ble_scan_stop()`: the radios.
//! - `transport_open(kind, id, events)`: opens a port by name or a radio by device ID; bytes and the close reason
//!   come back on the `events` channel (an ArrayBuffer per read, a string when the link drops).
//! - `transport_write(bytes)`, `transport_set_baud(rate)` (the cable), `transport_close()`.

mod ble;
mod serial;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::sync::Mutex;

/// What a transport sends the webview.
#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    Data(Vec<u8>),
    Closed(String),
}

fn sink(ch: Channel<InvokeResponseBody>) -> impl Fn(Event) + Send + Sync + 'static {
    move |e| {
        let _ = match e {
            Event::Data(b) => ch.send(InvokeResponseBody::Raw(b)),
            Event::Closed(why) => ch.send(InvokeResponseBody::Json(serde_json::to_string(&why).unwrap_or_default())),
        };
    }
}

enum Open {
    Serial(serial::SerialLink),
    Ble(ble::BleLink),
}

#[derive(Default)]
struct App {
    open: Mutex<Option<Open>>,
    central: ble::Radios,
}

impl App {
    async fn shut(&self) {
        match self.open.lock().await.take() {
            Some(Open::Serial(s)) => {
                let _ = tauri::async_runtime::spawn_blocking(move || s.close()).await;
            }
            Some(Open::Ble(b)) => b.close().await,
            None => {}
        }
    }
}

#[derive(serde::Serialize)]
struct Opened {
    label: String,
    baud: Option<u32>,
}

#[tauri::command]
async fn serial_ports() -> Result<Vec<serial::PortRow>, String> {
    tauri::async_runtime::spawn_blocking(serial::list).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ble_scan_start(app: State<'_, App>) -> Result<(), String> {
    app.central.scan_start().await
}

#[tauri::command]
async fn ble_devices(app: State<'_, App>) -> Result<Vec<ble::BleRow>, String> {
    app.central.devices().await
}

#[tauri::command]
async fn ble_scan_stop(app: State<'_, App>) -> Result<(), String> {
    app.central.scan_stop().await
}

#[tauri::command]
async fn transport_open(
    app: State<'_, App>,
    kind: String,
    id: String,
    events: Channel<InvokeResponseBody>,
) -> Result<Opened, String> {
    app.shut().await;
    let (open, opened) = match kind.as_str() {
        "cable" => {
            let base = ferrite_console_core::timing::CABLE_BAUD;
            let s = tauri::async_runtime::spawn_blocking(move || serial::SerialLink::open(&id, base, sink(events)))
                .await
                .map_err(|e| e.to_string())??;
            let opened = Opened { label: s.label.clone(), baud: Some(s.baud()) };
            (Open::Serial(s), opened)
        }
        "bluetooth" => {
            let b = app.central.open(&id, sink(events)).await?;
            let opened = Opened { label: b.label.clone(), baud: None };
            (Open::Ble(b), opened)
        }
        other => return Err(format!("No native transport for {other}.")),
    };
    *app.open.lock().await = Some(open);
    Ok(opened)
}

#[tauri::command]
async fn transport_write(app: State<'_, App>, bytes: Vec<u8>) -> Result<(), String> {
    match app.open.lock().await.as_ref() {
        Some(Open::Serial(s)) => s.write(&bytes),
        Some(Open::Ble(b)) => b.write(&bytes).await,
        None => Err("Not connected.".into()),
    }
}

#[tauri::command]
async fn transport_set_baud(app: State<'_, App>, rate: u32) -> Result<(), String> {
    match app.open.lock().await.as_ref() {
        Some(Open::Serial(s)) => s.set_baud(rate),
        _ => Err("Only the cable has a rate.".into()),
    }
}

#[tauri::command]
async fn transport_close(app: State<'_, App>) -> Result<(), String> {
    app.shut().await;
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
        .manage(App::default())
        .invoke_handler(tauri::generate_handler![
            serial_ports,
            ble_scan_start,
            ble_devices,
            ble_scan_stop,
            transport_open,
            transport_write,
            transport_set_baud,
            transport_close,
            core_protocol
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ferrite Console");
}
