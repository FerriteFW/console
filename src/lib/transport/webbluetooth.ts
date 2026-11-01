// The radio's Bluetooth (the BT513 module) through Chrome's Web Bluetooth: service FFE0, characteristic FFE1 (write
// without response, notify), 20-byte writes 25 ms apart (ferrite_link.py's BlePort; LINK-25). FF31, the module's
// own control characteristic, takes one write only: the speed unlock (LINK-15.1, approved Oct 14, 2026).
import { P } from "../core";
import { sleep, type Transport } from "./types";

const SERVICE = 0xffe0;
const DATA = 0xffe1;
const CONTROL = 0xff31;

type Characteristic = {
  value: DataView | null;
  writeValueWithoutResponse?(b: BufferSource): Promise<void>;
  writeValue(b: BufferSource): Promise<void>;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  addEventListener(t: "characteristicvaluechanged", f: (e: Event) => void): void;
};
type Device = {
  name?: string;
  gatt: {
    connected: boolean;
    connect(): Promise<{ getPrimaryService(s: number): Promise<{ getCharacteristic(c: number): Promise<Characteristic> }> }>;
    disconnect(): void;
  };
  addEventListener(t: "gattserverdisconnected", f: () => void): void;
};
type BluetoothLike = { requestDevice(o: { filters: { services: number[] }[] }): Promise<Device> };

export const webBluetooth = (): BluetoothLike | undefined => (navigator as unknown as { bluetooth?: BluetoothLike }).bluetooth;

export class WebBluetoothTransport implements Transport {
  readonly kind = "bluetooth" as const;
  readonly slow = true;
  label = "Bluetooth";
  onData: (b: Uint8Array) => void = () => {};
  onClose: (why: string) => void = () => {};
  private queue: Promise<void> = Promise.resolve();
  private closing = false;

  private constructor(
    private device: Device,
    private ch: Characteristic,
    private service: { getCharacteristic(c: number): Promise<Characteristic> },
  ) {}

  /**
   * LINK-15.1: the module's per-connection speed unlock, the only FF31 write: `3F 3F 3F 3F`, selector `02` (115200),
   * 15 random bytes, written with response (FF31 ignores a write without). Its `!!!!` answer comes on FFE1; Link
   * drops it.
   */
  async unlock(): Promise<boolean> {
    try {
      const c = await this.service.getCharacteristic(CONTROL);
      const token = new Uint8Array(20);
      token.set([0x3f, 0x3f, 0x3f, 0x3f, 0x02]);
      crypto.getRandomValues(token.subarray(5));
      await c.writeValue(token);
      return true;
    } catch {
      return false;
    }
  }

  static async request(): Promise<WebBluetoothTransport> {
    const bt = webBluetooth();
    if (!bt) throw new Error("This browser has no Web Bluetooth: use Chrome or Edge, from https or localhost.");
    // The BT513 advertises FFE0 (as tools/webble does it); the chooser lists it as "walkie-talkie".
    return WebBluetoothTransport.fromDevice(await bt.requestDevice({ filters: [{ services: [SERVICE] }] }));
  }

  /** The same radio again (reconnecting): the device this page was given, if it's in range. */
  reopen(): Promise<WebBluetoothTransport> {
    return WebBluetoothTransport.fromDevice(this.device);
  }

  private static async fromDevice(device: Device): Promise<WebBluetoothTransport> {
    const server = await Promise.race([
      device.gatt.connect(),
      sleep(15_000).then(() => {
        throw new Error("The radio didn't answer the Bluetooth connection.");
      }),
    ]);
    const service = await server.getPrimaryService(SERVICE);
    const ch = await service.getCharacteristic(DATA);
    const t = new WebBluetoothTransport(device, ch, service);
    t.label = `Bluetooth: ${device.name || "radio"}`;
    ch.addEventListener("characteristicvaluechanged", (e) => {
      const v = (e.target as unknown as Characteristic).value;
      if (v) t.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    });
    device.addEventListener("gattserverdisconnected", () => {
      if (!t.closing) t.onClose("Bluetooth disconnected (out of range, or the radio's Bluetooth went off).");
    });
    await ch.startNotifications();
    return t;
  }

  /** Writes in 20-byte pieces, paced; whole writes never interleave. */
  write(bytes: Uint8Array): Promise<void> {
    const { ble_chunk, ble_pace_ms } = P.timing;
    const run = async () => {
      for (let i = 0; i < bytes.length; i += ble_chunk) {
        const part = bytes.slice(i, i + ble_chunk);
        if (this.ch.writeValueWithoutResponse) await this.ch.writeValueWithoutResponse(part);
        else await this.ch.writeValue(part);
        await sleep(ble_pace_ms);
      }
    };
    const r = this.queue.then(run, run);
    this.queue = r.catch(() => {});
    return r;
  }

  async close() {
    this.closing = true;
    try {
      await this.ch.stopNotifications();
    } catch {
      /* gone already */
    }
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }
}
