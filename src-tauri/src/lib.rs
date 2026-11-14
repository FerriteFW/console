//! Ferrite Console's desktop shell (Tauri 2; iOS and Android later on the same base). The UI is the web build's,
//! and the protocol runs in it (the core as wasm), so the shell only moves bytes for the webviews that have no Web
//! Serial or Web Bluetooth (WKWebView on macOS, WebKitGTK on Linux).
//!
//! The commands src/lib/transport/native.ts calls:
//! - `serial_ports()`: the ports for the picker. `ble_scan_start()`, `ble_devices()`, `ble_scan_stop()`: the radios.
//! - `transport_open(kind, id, events)`: opens a port by name or a radio by device ID; bytes and the close reason
//!   come back on the `events` channel (an ArrayBuffer per read, a string when the link drops).
//! - `transport_write(bytes)`, `transport_set_baud(rate)` (the cable), `transport_close()`.
//! - `save_file` (raw body, the `x-name` header): the native save dialog, the file written and read back; the path,
//!   or null when cancelled (the Install page's backup, BACKUP-2; the .ferrite codeplug's Save as… and Back up radio).

mod ble;
mod debug;
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
            Event::Data(b) => {
                if debug::on() {
                    debug::line(&format!("received {} B", b.len()));
                }
                ch.send(InvokeResponseBody::Raw(b))
            }
            Event::Closed(why) => {
                debug::line(&format!("closed: {why}"));
                ch.send(InvokeResponseBody::Json(serde_json::to_string(&why).unwrap_or_default()))
            }
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
    let r = tauri::async_runtime::spawn_blocking(serial::list).await.map_err(|e| e.to_string()).and_then(|r| r);
    debug::result("serial_ports", &r);
    r
}

#[tauri::command]
async fn ble_scan_start(app: State<'_, App>) -> Result<(), String> {
    let r = app.central.scan_start().await;
    debug::result("ble_scan_start", &r);
    r
}

#[tauri::command]
async fn ble_devices(app: State<'_, App>) -> Result<Vec<ble::BleRow>, String> {
    let r = app.central.devices().await;
    debug::result("ble_devices", &r);
    r
}

#[tauri::command]
async fn ble_scan_stop(app: State<'_, App>) -> Result<(), String> {
    let r = app.central.scan_stop().await;
    debug::result("ble_scan_stop", &r);
    r
}

#[tauri::command]
async fn transport_open(
    app: State<'_, App>,
    kind: String,
    id: String,
    events: Channel<InvokeResponseBody>,
) -> Result<Opened, String> {
    debug::line(&format!("transport_open {kind} {id}"));
    let r = open_transport(&app, kind, id, events).await;
    debug::result("transport_open", &r.as_ref().map(|o| (&o.label, o.baud)).map_err(|e| e.clone()));
    r
}

async fn open_transport(
    app: &State<'_, App>,
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
    let r = match app.open.lock().await.as_ref() {
        Some(Open::Serial(s)) => s.write(&bytes),
        Some(Open::Ble(b)) => b.write(&bytes).await,
        None => Err("Not connected.".into()),
    };
    if debug::on() {
        debug::result(&format!("transport_write {} B", bytes.len()), &r);
    }
    r
}

#[tauri::command]
async fn transport_set_baud(app: State<'_, App>, rate: u32) -> Result<(), String> {
    let r = match app.open.lock().await.as_ref() {
        Some(Open::Serial(s)) => s.set_baud(rate),
        _ => Err("Only the cable has a rate.".into()),
    };
    debug::result(&format!("transport_set_baud {rate}"), &r);
    r
}

/// LINK-15.1: Bluetooth's speed unlock (FF31; only that shape is ever written: `ble::is_unlock`).
#[tauri::command]
async fn transport_unlock(app: State<'_, App>, token: Vec<u8>) -> Result<(), String> {
    match app.open.lock().await.as_ref() {
        Some(Open::Ble(b)) => b.unlock(&token).await,
        _ => Err("Only Bluetooth has a speed unlock.".into()),
    }
}

#[tauri::command]
async fn transport_close(app: State<'_, App>) -> Result<(), String> {
    debug::line("transport_close");
    app.shut().await;
    Ok(())
}

#[tauri::command]
async fn save_file(request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("No file bytes.".into());
    };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or("backup.bin").to_string();
    let Some(f) = rfd::AsyncFileDialog::new().set_file_name(&name).save_file().await else {
        return Ok(None);
    };
    let path = f.path().to_path_buf();
    std::fs::write(&path, bytes).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    // Read back: the page only goes on when the file on disk is the backup.
    let back = std::fs::read(&path).map_err(|e| format!("Couldn't read {} back: {e}", path.display()))?;
    if back != *bytes {
        return Err(format!("{} doesn't read back as written.", path.display()));
    }
    Ok(Some(path.display().to_string()))
}

/// The debug switch (debug.rs): whether it's on, and the log file, for the webview.
#[tauri::command]
fn debug_state() -> Option<String> {
    debug::path()
}

/// A line from the webview into the debug log (its errors, the connect steps); nothing when debug is off.
#[tauri::command]
fn debug_log(line: String) {
    debug::line(&format!("ui: {line}"));
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
        // UPD-26: Console's own updates (the page checks only once the releases are public: updates.ts)
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // The window fits the screen it opens on (a 14" MacBook is ~1512 x 945 points): 90 % of its height, up to
        // 1440 wide, centred. The config's size is only the fallback.
        .setup(|app| {
            use tauri::Manager;
            debug::header();
            if let Some(w) = app.get_webview_window("main") {
                if debug::on() {
                    w.open_devtools();
                }
                if let Ok(Some(m)) = w.current_monitor() {
                    let s = m.size().to_logical::<f64>(m.scale_factor());
                    let size = tauri::LogicalSize::new((s.width * 0.9).min(1440.0), (s.height * 0.9).min(1100.0));
                    let _ = w.set_size(size);
                    let _ = w.center();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            serial_ports,
            ble_scan_start,
            transport_unlock,
            ble_devices,
            ble_scan_stop,
            transport_open,
            transport_write,
            transport_set_baud,
            transport_close,
            core_protocol,
            debug_state,
            debug_log,
            save_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ferrite Console");
}
