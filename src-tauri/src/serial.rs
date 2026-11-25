//! The programming cable through the `serialport` crate: 115200 8N1 at open, the rate changed in place for BAUD
//! (LINK-11, LINK-13.3), one I/O thread doing the writes and sending what arrives to the webview.

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
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

/// How long one read waits for a byte: a write or a rate change waits at most this long for the I/O thread.
const READ_WAIT: Duration = Duration::from_millis(10);
/// A write that makes no progress (a full output buffer) gives up after this long.
const WRITE_WAIT: Duration = Duration::from_secs(2);

/// What the I/O thread does between reads.
enum Cmd {
    Write(Vec<u8>, mpsc::Sender<Result<(), String>>),
    Baud(u32, mpsc::Sender<Result<(), String>>),
}

/// An open cable: one I/O thread owns the port and does its reads, writes and rate changes in turn (issue #92).
/// On Windows the port isn't opened overlapped, so a second thread's `WriteFile` on a cloned handle waited behind
/// the reader's `ReadFile`, for a whole read time-out or longer; one thread never has two calls on the port at once.
pub struct SerialLink {
    cmds: mpsc::Sender<Cmd>,
    baud: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
    io: Option<JoinHandle<()>>,
    pub label: String,
}

impl SerialLink {
    pub fn open(name: &str, baud: u32, sink: impl Fn(Event) + Send + 'static) -> Result<Self, String> {
        let port = serialport::new(name, baud)
            .data_bits(serialport::DataBits::Eight)
            .stop_bits(serialport::StopBits::One)
            .parity(serialport::Parity::None)
            .flow_control(serialport::FlowControl::None)
            .timeout(READ_WAIT)
            .open()
            .map_err(|e| open_error(name, &e))?;
        let chip = list().ok().and_then(|ps| ps.into_iter().find(|p| p.name == name)).filter(|p| p.cable);
        let label = match chip {
            Some(p) => format!("Cable ({})", p.detail.trim_end_matches(" USB serial")),
            None => "Cable".into(),
        };
        Self::start(port, label, sink)
    }

    /// Runs the I/O thread on an open port (a pty in the tests).
    pub fn start(
        mut port: Box<dyn SerialPort>,
        label: String,
        sink: impl Fn(Event) + Send + 'static,
    ) -> Result<Self, String> {
        port.set_timeout(READ_WAIT).map_err(|e| format!("Couldn't set up the port: {e}"))?;
        let baud = Arc::new(AtomicU32::new(port.baud_rate().unwrap_or(0)));
        let rate = baud.clone();
        let (cmds, todo) = mpsc::channel::<Cmd>();
        let stop = Arc::new(AtomicBool::new(false));
        let quit = stop.clone();
        let io = std::thread::Builder::new()
            .name("serial-io".into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                while !quit.load(Ordering::Relaxed) {
                    // what's asked for first: a write waits behind one read at most
                    while let Ok(cmd) = todo.try_recv() {
                        match cmd {
                            Cmd::Write(bytes, done) => {
                                let _ = done.send(write_all(port.as_mut(), &bytes, WRITE_WAIT));
                            }
                            Cmd::Baud(r, done) => {
                                let set = port
                                    .set_baud_rate(r)
                                    .map_err(|e| format!("Couldn't set the cable to {r} baud: {e}"));
                                if set.is_ok() {
                                    rate.store(r, Ordering::Relaxed);
                                }
                                let _ = done.send(set);
                            }
                        }
                    }
                    match port.read(&mut buf) {
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
        Ok(Self { cmds, baud, stop, io: Some(io), label })
    }

    pub fn baud(&self) -> u32 {
        self.baud.load(Ordering::Relaxed)
    }

    /// Hands `cmd` to the I/O thread and waits for its result.
    fn ask(&self, cmd: impl FnOnce(mpsc::Sender<Result<(), String>>) -> Cmd) -> Result<(), String> {
        let (done, result) = mpsc::channel();
        self.cmds.send(cmd(done)).map_err(|_| "The cable stopped.".to_string())?;
        result.recv().map_err(|_| "The cable stopped.".to_string())?
    }

    /// Queued, not drained (as Web Serial's write).
    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        self.ask(|done| Cmd::Write(bytes.to_vec(), done))
    }

    /// Changes the rate in place (unlike Web Serial, no reopen).
    pub fn set_baud(&self, rate: u32) -> Result<(), String> {
        self.ask(|done| Cmd::Baud(rate, done))
    }

    pub fn close(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(r) = self.io.take() {
            let _ = r.join(); // within one read time-out
        }
    }
}

/// All of `bytes` to the port. The port's time-out only bounds each piece, so a full output buffer is waited out
/// for up to `wait`; a write that takes nothing (`Ok(0)`) counts against it too, never spinning for ever.
fn write_all(port: &mut dyn Write, bytes: &[u8], wait: Duration) -> Result<(), String> {
    let (mut left, until) = (bytes, Instant::now() + wait);
    while !left.is_empty() {
        match port.write(left) {
            Ok(n) if n > 0 => left = &left[n..],
            Ok(_) if Instant::now() < until => std::thread::sleep(Duration::from_millis(1)),
            Ok(_) => return Err("The cable stopped taking bytes.".into()),
            Err(e)
                if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock)
                    && Instant::now() < until => {}
            Err(e) => return Err(format!("The cable stopped: {e}")),
        }
    }
    Ok(())
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

        // a write while bytes keep arriving, and a rate change, both go through the one thread
        far.write_all(&[0x55; 64]).unwrap();
        link.write(b"pong").unwrap();
        far.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"pong");
        // (a pty has no rate to set: the answer comes back either way, and the rate kept says which)
        let set = link.set_baud(230_400);
        assert_eq!(set.is_ok(), link.baud() == 230_400, "{set:?}");

        link.close();
        while let Ok(e) = rx.recv_timeout(Duration::from_millis(200)) {
            assert!(matches!(e, Event::Data(_)), "no Closed after our own close");
        }
    }

    /// Issue #92: a port that takes nothing (`WriteFile` returning 0 bytes) fails the write once the wait is up,
    /// rather than looping for ever.
    #[test]
    fn a_write_that_takes_nothing_gives_up() {
        struct Stuck(u32);
        impl Write for Stuck {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                self.0 += 1;
                Ok(0)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut p = Stuck(0);
        let t = Instant::now();
        assert!(write_all(&mut p, b"x", Duration::from_millis(30)).is_err());
        assert!(t.elapsed() < Duration::from_secs(1) && p.0 > 1);
        struct Slow(Vec<u8>);
        impl Write for Slow {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                if self.0.len() % 2 == 1 {
                    self.0.push(0xEE); // every other call: nothing taken
                    return Ok(0);
                }
                self.0.push(b[0]);
                Ok(1)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut s = Slow(Vec::new());
        write_all(&mut s, b"abc", Duration::from_secs(1)).unwrap();
        assert_eq!(s.0.iter().filter(|&&b| b != 0xEE).copied().collect::<Vec<_>>(), b"abc");
    }
}
