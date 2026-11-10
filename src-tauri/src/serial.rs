//! The programming cable through the `serialport` crate: 115200 8N1 at open, the rate changed in place for BAUD
//! (LINK-11, LINK-13.3), a reader thread sending what arrives to the webview.

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use serialport::{SerialPort, SerialPortType};

use crate::Event;

/// USB vendor IDs of the chips programming cables use: CH340 (the RT-950 Pro's cable), CP210x, FTDI, Prolific.
const CABLE_CHIPS: [(u16, &str); 4] = [(0x1a86, "CH340"), (0x10c4, "CP210x"), (0x0403, "FTDI"), (0x067b, "Prolific")];

/// One port in the picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PortRow {
    /// What `open` takes: `/dev/cu.usbserial-114220`, `COM3`.
    pub name: String,
    /// What the picker shows under the name: "CH340 USB serial", "USB serial", "Bluetooth".
    pub detail: String,
    /// A USB-serial chip programming cables use.
    pub cable: bool,
}

/// The ports worth offering, cable chips first. macOS lists each port twice (`/dev/tty.*` and `/dev/cu.*`): only
/// the `cu` one is kept (it opens without waiting for carrier), and the Mac's own ports are left out.
pub fn rows(ports: Vec<serialport::SerialPortInfo>) -> Vec<PortRow> {
    let mut out: Vec<PortRow> = ports
        .into_iter()
        .filter(|p| !p.port_name.starts_with("/dev/tty."))
        // Linux lists every built-in UART slot (/dev/ttyS0-31) whether or not one is fitted: never the cable.
        .filter(|p| !(p.port_name.starts_with("/dev/ttyS") && matches!(p.port_type, SerialPortType::Unknown)))
        .filter(|p| {
            !["Bluetooth-Incoming-Port", "debug-console", "wlan-debug"].iter().any(|s| p.port_name.ends_with(s))
        })
        .map(|p| {
            let (detail, cable) = match &p.port_type {
                SerialPortType::UsbPort(u) => match CABLE_CHIPS.iter().find(|(vid, _)| *vid == u.vid) {
                    Some((_, chip)) => (format!("{chip} USB serial"), true),
                    None => (u.product.clone().unwrap_or_else(|| "USB serial".into()), false),
                },
                SerialPortType::BluetoothPort => ("Bluetooth".into(), false),
                SerialPortType::PciPort => ("Built-in".into(), false),
                SerialPortType::Unknown => (String::new(), false),
            };
            PortRow { name: p.port_name, detail, cable }
        })
        .collect();
    out.sort_by(|a, b| b.cable.cmp(&a.cable).then_with(|| a.name.cmp(&b.name)));
    out.dedup_by(|a, b| a.name == b.name);
    out
}

pub fn list() -> Result<Vec<PortRow>, String> {
    serialport::available_ports().map(rows).map_err(|e| format!("Couldn't list the serial ports: {e}"))
}

/// Why a port didn't open, in words a user can act on: on Linux the group that may open it (dialout on Fedora,
/// Debian and Ubuntu, uucp on Arch) by its name, read from the device itself; a port another program holds.
pub fn open_error(name: &str, e: &serialport::Error) -> String {
    use serialport::ErrorKind as K;
    let denied = matches!(e.kind(), K::Io(ErrorKind::PermissionDenied))
        || e.description.to_lowercase().contains("permission denied");
    let busy = e.description.to_lowercase().contains("busy");
    if denied {
        #[cfg(target_os = "linux")]
        {
            let group = port_group(name).unwrap_or_else(|| "dialout".into());
            if my_groups().iter().any(|g| *g == group) {
                return format!(
                    "Linux won't let Ferrite Console open {name}, though you're in the {group} group: log out and back \
                     in (or restart) so the group takes effect. ({})",
                    e.description
                );
            }
            return format!(
                "Linux won't let Ferrite Console open {name}: your user isn't in the {group} group, which may use \
                 serial ports. Run this in a terminal, then log out and back in (or restart):\n\n    sudo usermod -aG {group} $USER\n\n({})",
                e.description
            );
        }
        #[allow(unreachable_code)]
        return format!("This computer won't let Ferrite Console open {name} (permission denied): {}", e.description);
    }
    if busy {
        return format!(
            "{name} is in use by another program (another Console, CHIRP, a terminal, ModemManager or brltty): close \
             it and try again. ({})",
            e.description
        );
    }
    if matches!(e.kind(), K::NoDevice) {
        return format!("{name} isn't there any more: is the cable still plugged in? ({})", e.description);
    }
    format!("Couldn't open {name}: {e}")
}

/// The group that owns a device file (Linux), by name.
#[cfg(target_os = "linux")]
fn port_group(name: &str) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let gid = std::fs::metadata(name).ok()?.gid();
    group_name(gid)
}

#[cfg(target_os = "linux")]
fn group_name(gid: u32) -> Option<String> {
    let groups = std::fs::read_to_string("/etc/group").ok()?;
    groups.lines().find_map(|l| {
        let mut f = l.split(':');
        let name = f.next()?;
        let _ = f.next();
        (f.next()?.parse::<u32>().ok()? == gid).then(|| name.to_string())
    })
}

/// This process's groups by name (Linux; empty elsewhere): what a new login would have is in /etc/group, but a
/// running session keeps the groups it started with, which is what counts for opening a port.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn my_groups() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let ids = status.lines().find_map(|l| l.strip_prefix("Groups:")).unwrap_or("");
        return ids.split_whitespace().filter_map(|g| g.parse().ok()).filter_map(group_name).collect();
    }
    #[allow(unreachable_code)]
    Vec::new()
}

/// An open cable: the port for writes and rate changes, and the reader thread.
pub struct SerialLink {
    port: Arc<Mutex<Box<dyn SerialPort>>>,
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    pub label: String,
}

impl SerialLink {
    pub fn open(name: &str, baud: u32, sink: impl Fn(Event) + Send + 'static) -> Result<Self, String> {
        let port = serialport::new(name, baud)
            .data_bits(serialport::DataBits::Eight)
            .stop_bits(serialport::StopBits::One)
            .parity(serialport::Parity::None)
            .flow_control(serialport::FlowControl::None)
            .timeout(Duration::from_millis(50))
            .open()
            .map_err(|e| open_error(name, &e))?;
        let chip = list().ok().and_then(|ps| ps.into_iter().find(|p| p.name == name)).filter(|p| p.cable);
        let label = match chip {
            Some(p) => format!("Cable ({})", p.detail.trim_end_matches(" USB serial")),
            None => "Cable".into(),
        };
        Self::start(port, label, sink)
    }

    /// Runs the reader on an open port (a pty in the tests).
    pub fn start(
        port: Box<dyn SerialPort>,
        label: String,
        sink: impl Fn(Event) + Send + 'static,
    ) -> Result<Self, String> {
        let mut rx = port.try_clone().map_err(|e| format!("Couldn't read the port: {e}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let quit = stop.clone();
        let reader = std::thread::Builder::new()
            .name("serial-reader".into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                while !quit.load(Ordering::Relaxed) {
                    match rx.read(&mut buf) {
                        Ok(0) => {
                            if !quit.load(Ordering::Relaxed) {
                                sink(Event::Closed("The cable was unplugged.".into()));
                            }
                            return;
                        }
                        Ok(n) => sink(Event::Data(buf[..n].to_vec())),
                        Err(e)
                            if matches!(
                                e.kind(),
                                ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock
                            ) => {}
                        Err(e) => {
                            if !quit.load(Ordering::Relaxed) {
                                sink(Event::Closed(format!("The cable stopped: {e}")));
                            }
                            return;
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { port: Arc::new(Mutex::new(port)), stop, reader: Some(reader), label })
    }

    pub fn baud(&self) -> u32 {
        self.port.lock().ok().and_then(|p| p.baud_rate().ok()).unwrap_or(0)
    }

    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        // Queued, not drained (as Web Serial's write): the port's 50 ms time-out only bounds each piece, so a full
        // output buffer is waited out for up to 2 s.
        let mut p = self.port.lock().map_err(|_| "The cable's lock broke.".to_string())?;
        let (mut left, until) = (bytes, Instant::now() + Duration::from_secs(2));
        while !left.is_empty() {
            match p.write(left) {
                Ok(n) => left = &left[n..],
                Err(e)
                    if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock)
                        && Instant::now() < until => {}
                Err(e) => return Err(format!("The cable stopped: {e}")),
            }
        }
        Ok(())
    }

    /// Changes the rate in place (unlike Web Serial, no reopen).
    pub fn set_baud(&self, rate: u32) -> Result<(), String> {
        let mut p = self.port.lock().map_err(|_| "The cable's lock broke.".to_string())?;
        p.set_baud_rate(rate).map_err(|e| format!("Couldn't set the cable to {rate} baud: {e}"))
    }

    pub fn close(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(r) = self.reader.take() {
            let _ = r.join(); // within one read time-out
        }
    }
}

impl Drop for SerialLink {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serialport::{SerialPortInfo, UsbPortInfo};

    fn usb(name: &str, vid: u16, product: Option<&str>) -> SerialPortInfo {
        SerialPortInfo {
            port_name: name.into(),
            port_type: SerialPortType::UsbPort(UsbPortInfo {
                vid,
                pid: 0x7523,
                serial_number: None,
                manufacturer: None,
                product: product.map(Into::into),
            }),
        }
    }

    #[test]
    fn rows_keep_cu_ports_and_put_cable_chips_first() {
        let rows = rows(vec![
            SerialPortInfo {
                port_name: "/dev/cu.Bluetooth-Incoming-Port".into(),
                port_type: SerialPortType::BluetoothPort,
            },
            usb("/dev/tty.usbserial-114220", 0x1a86, None),
            usb("/dev/cu.usbmodem1", 0x2e8a, Some("Pico")),
            usb("/dev/cu.usbserial-114220", 0x1a86, None),
        ]);
        assert_eq!(
            rows,
            vec![
                PortRow { name: "/dev/cu.usbserial-114220".into(), detail: "CH340 USB serial".into(), cable: true },
                PortRow { name: "/dev/cu.usbmodem1".into(), detail: "Pico".into(), cable: false },
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn bytes_go_both_ways_and_close_is_quiet() {
        use std::sync::mpsc;
        let (mut far, near) = serialport::TTYPort::pair().expect("a pty");
        let (tx, rx) = mpsc::channel();
        let link = SerialLink::start(Box::new(near), "Cable".into(), move |e| tx.send(e).unwrap()).unwrap();

        far.write_all(b"\x02hello").unwrap();
        let mut got = Vec::new();
        while got.len() < 6 {
            match rx.recv_timeout(Duration::from_secs(2)).expect("data") {
                Event::Data(b) => got.extend(b),
                Event::Closed(why) => panic!("closed: {why}"),
            }
        }
        assert_eq!(got, b"\x02hello");

        link.write(b"ping").unwrap();
        let mut back = [0u8; 4];
        far.set_timeout(Duration::from_secs(2)).unwrap();
        far.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"ping");

        link.close();
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "no Closed after our own close");
    }
}
