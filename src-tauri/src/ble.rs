//! The radio's Bluetooth (the BT513 module) through `btleplug`: service FFE0, characteristic FFE1 (notify, write
//! without response), 20-byte writes 25 ms apart (LINK-25). The radio is picked by the platform's device ID, never
//! by name (every radio advertises "walkie-talkie"). Only FFE1 is ever written: FF31, the module's own control
//! characteristic, is never touched, and no AT command is ever sent.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use btleplug::api::bleuuid::uuid_from_u16;
use btleplug::api::{
    Central as _, CentralEvent, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use ferrite_console_core::timing::{BLE_CHUNK, BLE_PACE_MS};
use futures::StreamExt;
use serde::Serialize;
use tokio::sync::{Mutex, OnceCell};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::Event;

pub const SERVICE: Uuid = uuid_from_u16(0xffe0);
pub const DATA: Uuid = uuid_from_u16(0xffe1);
/// The name the BT513 advertises (every radio the same).
pub const RADIO_NAME: &str = "walkie-talkie";

/// One device in the picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BleRow {
    /// The platform's ID (a UUID on macOS, the address elsewhere): what `open` takes.
    pub id: String,
    pub name: String,
    pub rssi: Option<i16>,
}

/// A radio: it advertises FFE0, or the BT513's name.
pub fn is_radio(name: Option<&str>, services: &[Uuid]) -> bool {
    services.contains(&SERVICE) || name == Some(RADIO_NAME)
}

/// Splits a write into the pieces the radio takes (LINK-25).
pub fn chunks(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.chunks(BLE_CHUNK)
}

/// The Bluetooth adapter, found once and kept: a peripheral found in a scan belongs to its adapter.
#[derive(Default)]
pub struct Radios {
    adapter: OnceCell<Adapter>,
}

impl Radios {
    async fn adapter(&self) -> Result<&Adapter, String> {
        self.adapter
            .get_or_try_init(|| async {
                let manager = Manager::new().await.map_err(|e| format!("Bluetooth isn't available: {e}"))?;
                let adapters = manager.adapters().await.map_err(|e| format!("Bluetooth isn't available: {e}"))?;
                adapters.into_iter().next().ok_or_else(|| "This computer has no Bluetooth adapter.".to_string())
            })
            .await
    }

    /// Starts scanning (no filter: some adverts carry the name without FFE0); `devices` reads what it found.
    pub async fn scan_start(&self) -> Result<(), String> {
        let a = self.adapter().await?;
        a.start_scan(ScanFilter::default()).await.map_err(|e| {
            format!("Couldn't scan for Bluetooth devices (is Bluetooth on, and allowed for Ferrite Console?): {e}")
        })
    }

    pub async fn scan_stop(&self) -> Result<(), String> {
        let a = self.adapter().await?;
        a.stop_scan().await.map_err(|e| e.to_string())
    }

    /// The radios seen so far, strongest first.
    pub async fn devices(&self) -> Result<Vec<BleRow>, String> {
        let a = self.adapter().await?;
        let mut out = Vec::new();
        for p in a.peripherals().await.map_err(|e| e.to_string())? {
            let Ok(Some(props)) = p.properties().await else { continue };
            if !is_radio(props.local_name.as_deref(), &props.services) {
                continue;
            }
            out.push(BleRow {
                id: p.id().to_string(),
                name: props.local_name.unwrap_or_else(|| "radio".into()),
                rssi: props.rssi,
            });
        }
        out.sort_by_key(|r| std::cmp::Reverse(r.rssi.unwrap_or(i16::MIN)));
        Ok(out)
    }

    async fn find(&self, id: &str) -> Result<Peripheral, String> {
        let a = self.adapter().await?;
        for round in 0..20 {
            for p in a.peripherals().await.map_err(|e| e.to_string())? {
                if p.id().to_string().eq_ignore_ascii_case(id) {
                    if round > 0 {
                        let _ = a.stop_scan().await;
                    }
                    return Ok(p);
                }
            }
            if round == 0 {
                a.start_scan(ScanFilter::default()).await.map_err(|e| e.to_string())?;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let _ = a.stop_scan().await;
        Err(format!("No Bluetooth radio with the ID {id} is in range (is the radio's Bluetooth on?)."))
    }

    /// Connects to the radio with this ID and starts its notifications.
    pub async fn open(&self, id: &str, sink: impl Fn(Event) + Send + Sync + 'static) -> Result<BleLink, String> {
        let a = self.adapter().await?.clone();
        let p = self.find(id).await?;
        let _ = a.stop_scan().await;
        tokio::time::timeout(Duration::from_secs(15), p.connect())
            .await
            .map_err(|_| "The radio didn't answer the Bluetooth connection.".to_string())?
            .map_err(|e| format!("Couldn't connect over Bluetooth: {e}"))?;
        let ready = async {
            p.discover_services().await.map_err(|e| format!("Couldn't read the radio's Bluetooth services: {e}"))?;
            let ch = p
                .characteristics()
                .into_iter()
                .find(|c| c.service_uuid == SERVICE && c.uuid == DATA)
                .ok_or_else(|| "This device has no FFE0/FFE1 (not an RT-950 Pro's Bluetooth?).".to_string())?;
            let notes = p.notifications().await.map_err(|e| e.to_string())?;
            p.subscribe(&ch).await.map_err(|e| format!("Couldn't start the radio's notifications: {e}"))?;
            Ok::<_, String>((ch, notes))
        };
        let (ch, mut notes) = match ready.await {
            Ok(v) => v,
            Err(e) => {
                let _ = p.disconnect().await;
                return Err(e);
            }
        };
        let name = p.properties().await.ok().flatten().and_then(|pr| pr.local_name).unwrap_or_else(|| "radio".into());

        let closing = Arc::new(AtomicBool::new(false));
        let sink = Arc::new(sink);
        let s = sink.clone();
        let reader = tokio::spawn(async move {
            while let Some(n) = notes.next().await {
                if n.uuid == DATA {
                    s(Event::Data(n.value));
                }
            }
        });
        let (s, quit, me) = (sink.clone(), closing.clone(), p.id());
        let mut events = a.events().await.map_err(|e| e.to_string())?;
        let watcher = tokio::spawn(async move {
            while let Some(e) = events.next().await {
                if matches!(e, CentralEvent::DeviceDisconnected(ref id) if *id == me) {
                    if !quit.load(Ordering::Relaxed) {
                        s(Event::Closed(
                            "Bluetooth disconnected (out of range, or the radio's Bluetooth went off).".into(),
                        ));
                    }
                    return;
                }
            }
        });
        let kind = if ch.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) {
            WriteType::WithoutResponse
        } else {
            WriteType::WithResponse
        };
        Ok(BleLink {
            p,
            ch,
            kind,
            closing,
            tasks: vec![reader, watcher],
            write_lock: Mutex::new(()),
            label: format!("Bluetooth: {name}"),
        })
    }
}

/// A connected radio.
pub struct BleLink {
    p: Peripheral,
    ch: Characteristic,
    kind: WriteType,
    closing: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
    /// Whole writes never interleave.
    write_lock: Mutex<()>,
    pub label: String,
}

impl BleLink {
    /// Writes to FFE1 in 20-byte pieces, 25 ms apart.
    pub async fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let _held = self.write_lock.lock().await;
        for part in chunks(bytes) {
            self.p.write(&self.ch, part, self.kind).await.map_err(|e| format!("Bluetooth write failed: {e}"))?;
            tokio::time::sleep(Duration::from_millis(BLE_PACE_MS.into())).await;
        }
        Ok(())
    }

    pub async fn close(self) {
        self.closing.store(true, Ordering::Relaxed);
        let _ = self.p.unsubscribe(&self.ch).await;
        let _ = self.p.disconnect().await;
        for t in &self.tasks {
            t.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_the_bt513s() {
        assert_eq!(SERVICE.to_string(), "0000ffe0-0000-1000-8000-00805f9b34fb");
        assert_eq!(DATA.to_string(), "0000ffe1-0000-1000-8000-00805f9b34fb");
    }

    #[test]
    fn radios_by_service_or_name() {
        assert!(is_radio(None, &[SERVICE]));
        assert!(is_radio(Some("walkie-talkie"), &[]));
        assert!(!is_radio(Some("AirPods"), &[uuid_from_u16(0x180f)]));
        assert!(!is_radio(None, &[uuid_from_u16(0xff31)]));
    }

    #[test]
    fn writes_split_at_twenty_bytes() {
        let bytes: Vec<u8> = (0..45).collect();
        let parts: Vec<usize> = chunks(&bytes).map(<[u8]>::len).collect();
        assert_eq!(parts, [20, 20, 5]);
    }
}
