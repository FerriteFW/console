// APRS contacts (APRS-37, APRS-42): the radio's address book as record 6, in callsign order. Read whole (128 at
// most); each change is written at once by callsign, then read back.
import { radio } from "./radio.svelte";

export type Contact = { call: string; name: string };

export const MAX = 128;
const NAME_SYMBOLS = "-./_#+&()'!";
/** A callsign as compose takes it: capitals, digits and "-", 3 to 9. */
export const callOk = (c: string) => /^[A-Z0-9-]{3,9}$/.test(c);
/** A name in the channel-name set (decision 221), others as "-", 12 at most. */
export const cleanName = (n: string) =>
  [...n.slice(0, 12)].map((c) => (/[A-Za-z0-9 ]/.test(c) || NAME_SYMBOLS.includes(c) ? c : "-")).join("");

const text = (b: Uint8Array) => new TextDecoder().decode(b.slice(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));

function record(c: Contact, del = false): Uint8Array {
  const r = new Uint8Array(23);
  r.set(new TextEncoder().encode(c.call).slice(0, 10), 0);
  r.set(new TextEncoder().encode(cleanName(c.name)), 10);
  r[22] = del ? 1 : 0;
  return r;
}

class Contacts {
  list = $state<Contact[]>([]);
  loaded = $state(false);
  busy = $state("");
  error = $state("");

  async read() {
    const link = radio.connectedLink;
    if (!link) return;
    this.busy = "Reading contacts";
    this.error = "";
    try {
      const got = await link.readMany(6, 0, MAX);
      this.list = [...got.values()].map((r) => ({ call: text(r.slice(0, 10)), name: text(r.slice(10, 22)) }));
      this.loaded = true;
    } catch (e) {
      this.error = `Couldn't read the contacts: ${(e as Error).message}`;
    } finally {
      this.busy = "";
    }
  }

  /** Saves (adds or renames) and deletes, then reads back. */
  async write(save: Contact[], del: string[] = []) {
    const link = radio.connectedLink;
    if (!link) return;
    this.busy = "Writing contacts";
    this.error = "";
    try {
      await link.writeContacts([...save.map((c) => record(c)), ...del.map((call) => record({ call, name: "" }, true))]);
    } catch (e) {
      this.error = `The radio refused it: ${(e as Error).message}`;
    } finally {
      this.busy = "";
    }
    await this.read();
  }

  forget() {
    this.list = [];
    this.loaded = false;
  }
}

export const contacts = new Contacts();

/** A CSV of `callsign,name` lines (a header line is skipped): the contacts in it, and the lines refused. */
export function parseCsv(csv: string): { ok: Contact[]; bad: string[] } {
  const ok: Contact[] = [];
  const bad: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const [c = "", ...rest] = line.split(",");
    const call = c.trim().toUpperCase();
    if (!call || call === "CALLSIGN") continue;
    if (callOk(call)) ok.push({ call, name: rest.join(",").trim().replace(/^"|"$/g, "") });
    else bad.push(line);
  }
  return { ok, bad };
}
