//! Where this computer is (decision 398): on macOS from Core Location, since wry passes no geolocation through to
//! WKWebView; elsewhere None, and the page asks the browser's. The first ask shows macOS's permission prompt
//! (Info.plist's NSLocationWhenInUseUsageDescription; the signed app's location entitlement).

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Here {
    pub lat: f64,
    pub lon: f64,
    /// Metres, as macOS gives it.
    pub accuracy: f64,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Here;
    use objc2::rc::Retained;
    use objc2_core_location::{CLAuthorizationStatus, CLLocationManager};
    use std::cell::RefCell;

    thread_local! {
        // The one manager, made and used on the main thread (Core Location delivers there).
        static MANAGER: RefCell<Option<Retained<CLLocationManager>>> = const { RefCell::new(None) };
    }

    /// On the main thread: start (or keep) updating, asking permission the first time. The last fix, or why none.
    pub fn poll() -> Result<Option<Here>, String> {
        MANAGER.with(|m| {
            let mut m = m.borrow_mut();
            let mgr = m.get_or_insert_with(|| {
                // SAFETY: Core Location's own API, on the main thread.
                let mgr = unsafe { CLLocationManager::new() };
                unsafe {
                    mgr.requestWhenInUseAuthorization();
                    mgr.startUpdatingLocation();
                }
                mgr
            });
            // SAFETY: as above.
            let status = unsafe { mgr.authorizationStatus() };
            if status == CLAuthorizationStatus::Denied || status == CLAuthorizationStatus::Restricted {
                return Err("Location is off for Ferrite Console: System Settings › Privacy & Security › Location Services".into());
            }
            Ok(unsafe { mgr.location() }.map(|l| {
                let c = unsafe { l.coordinate() };
                Here { lat: c.latitude, lon: c.longitude, accuracy: unsafe { l.horizontalAccuracy() } }
            }))
        })
    }
}

/// This computer's position: waits up to 20 s for macOS's first fix (and the permission prompt's answer).
#[tauri::command]
pub async fn here(app: tauri::AppHandle) -> Result<Option<Here>, String> {
    #[cfg(target_os = "macos")]
    {
        for _ in 0..80 {
            let (tx, rx) = std::sync::mpsc::channel();
            app.run_on_main_thread(move || {
                let _ = tx.send(mac::poll());
            })
            .map_err(|e| e.to_string())?;
            match rx.recv().map_err(|e| e.to_string())? {
                Ok(Some(h)) => return Ok(Some(h)),
                Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
                Err(e) => return Err(e),
            }
        }
        Err("macOS gave no location within 20 s".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(None)
    }
}
