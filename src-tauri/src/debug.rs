//! The debug switch (Console 0.8.1): `FERRITE_DEBUG=1` in the environment, or `--debug` on the command line, opens
//! the webview's developer tools and logs every shell command, its result and the webview's own notes (errors, the
//! connect steps) to the terminal and to a file, `ferrite-console-debug.log` in the system's temp folder, which a
//! tester can send. Off, nothing is logged and nothing is written.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

struct Log {
    start: Instant,
    file: Mutex<Option<File>>,
    path: PathBuf,
}

static LOG: OnceLock<Option<Log>> = OnceLock::new();

fn log() -> Option<&'static Log> {
    LOG.get_or_init(|| {
        let on = std::env::var("FERRITE_DEBUG").is_ok_and(|v| !v.is_empty() && v != "0")
            || std::env::args().any(|a| a == "--debug");
        on.then(|| {
            let path = std::env::temp_dir().join("ferrite-console-debug.log");
            let file = OpenOptions::new().create(true).write(true).truncate(true).open(&path).ok();
            Log { start: Instant::now(), file: Mutex::new(file), path }
        })
    })
    .as_ref()
}

pub fn on() -> bool {
    log().is_some()
}

pub fn path() -> Option<String> {
    log().map(|l| l.path.display().to_string())
}

/// One line, with the seconds since start.
pub fn line(text: &str) {
    let Some(l) = log() else { return };
    let s = format!("[{:9.3}] {text}", l.start.elapsed().as_secs_f64());
    eprintln!("{s}");
    if let Ok(mut f) = l.file.lock() {
        if let Some(f) = f.as_mut() {
            let _ = writeln!(f, "{s}");
        }
    }
}

/// The header: version, system, time, where the log goes.
pub fn header() {
    if !on() {
        return;
    }
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    line(&format!(
        "Ferrite Console {} debug log: {} {}, unix time {secs}, log file {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        path().unwrap_or_default()
    ));
    #[cfg(target_os = "linux")]
    {
        let os = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        let pretty = os.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=")).unwrap_or("?").trim_matches('"');
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
        line(&format!("linux: {pretty}, session {session}, appimage {}", std::env::var("APPIMAGE").is_ok()));
        line(&format!("user groups: {}", crate::serial::my_groups().join(" ")));
    }
}

/// A command's result, logged with its name.
pub fn result<T: std::fmt::Debug>(what: &str, r: &Result<T, String>) {
    if on() {
        match r {
            Ok(v) => line(&format!("{what}: ok {v:?}")),
            Err(e) => line(&format!("{what}: ERROR {e}")),
        }
    }
}
