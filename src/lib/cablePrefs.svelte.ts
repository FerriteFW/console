// The cable's speed (decision 408): 115200 and no compression unless the owner turns High speed on (Live View),
// which raises it to 230400 (LINK-13.3). Users' cables lost bytes at 230400 (Windows, an Intel Mac's CH340), and a
// lost byte cost a write or an update; 115200 is the radio's own rate and the safe one. Kept per computer.
const KEY = "ferrite-console-cable-high-speed";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

class CablePrefs {
  #high = $state(read());
  /** High speed: the cable at 230400 after HELLO, and the backup's read at 230400. Off to start. */
  get highSpeed() {
    return this.#high;
  }
  set highSpeed(v: boolean) {
    this.#high = v;
    try {
      localStorage.setItem(KEY, v ? "on" : "off");
    } catch {
      /* this session only */
    }
  }
}

export const cablePrefs = new CablePrefs();
