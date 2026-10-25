// A link session over a transport, as ferrite_link.py's Link and Radio: the opening (Ctrl-C, then 0x00), one request
// at a time, answers matched by type and seq, a resync for read-only requests that got nothing, `busy` asked again,
// text answers paged with MORE, keys and the knob. Framing and parsing are the Rust core's.
import {
  P,
  Session,
  authPayload,
  baudPayload,
  helloPayload,
  keyPayload,
  knobPayloads,
  logReadPayload,
  msgSendPayload,
  parseHeard,
  parseHello,
  parseLogPage,
  parseMsgs,
  parseInfo,
  parseTextChunk,
  recordReader,
  statusText,
  subscribePayload,
  type Answer,
  type Hello,
  type Info,
  type LogRecord,
  type Message,
  type PlanOp,
  type Station,
} from "./core";
import { sleep, type Transport } from "./transport/types";

export const CLIENT_NAME = "Ferrite Console";

export class RadioError extends Error {
  constructor(
    readonly ty: number,
    readonly status: number,
    rest: Uint8Array = new Uint8Array(),
  ) {
    super(statusText(status, rest));
  }
}

export class TimeoutError extends Error {}

type Waiter = { ty: number; seq: number; resolve: (a: Answer) => void };

export class Link {
  private session = new Session();
  private waiter: Waiter | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private holdUntil = 0;
  private closed = false;
  /** Answers that matched nothing (late ones after a time-out), for the debug line. */
  stray = 0;
  /** Events (LINK-46): frames the radio sends unasked, never matched to a request: the frame's seq (the session's
   * event counter) and the payload (the kind, then its bytes). */
  onEvent: (seq: number, payload: Uint8Array) => void = () => {};

  constructor(readonly t: Transport) {
    t.onData = (bytes) => {
      if (this.closed) return;
      const answers: Answer[] = JSON.parse(this.session.feed(bytes));
      for (const a of answers) {
        if (a.event) {
          this.onEvent(a.seq, new Uint8Array(a.rest));
          continue;
        }
        const w = this.waiter;
        if (w && a.ty === (w.ty | 0x80) && a.seq === w.seq) {
          this.waiter = null;
          w.resolve(a);
        } else this.stray++;
      }
    };
  }

  /** TERM-2: Ctrl-C closes the radio's terminal if it holds the cable; its goodbye is dropped; 0x00 takes the cable. */
  async open() {
    await this.t.write(Session.opening());
    await sleep(P.timing.open_settle_ms);
    this.session.discard();
    await this.t.write(this.session.take_cable(performance.now()));
  }

  /** No more requests; whatever is in flight fails with "not connected". */
  close() {
    this.closed = true;
    const w = this.waiter;
    this.waiter = null;
    w?.resolve({ ty: 0, seq: 0, status: 0xff, rest: [] });
  }

  /** Runs `fn` when every request before it is done: one request on the link at a time. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(async () => {
      const wait = this.holdUntil - performance.now();
      if (wait > 0) await sleep(wait); // a remote long press is still held
      return fn();
    }, fn);
    this.chain = r.catch(() => {});
    return r;
  }

  private timeout() {
    return this.t.slow ? P.timing.ble_timeout_ms : P.timing.cable_timeout_ms;
  }

  /** One request and its answer, not queued (callers hold `exclusive`). HELLO, INFO and UI get one resync. */
  private async askRaw(
    ty: number,
    payload: Uint8Array,
    timeoutMs = this.timeout(),
    resync = true,
  ): Promise<{ status: number; rest: Uint8Array }> {
    if (this.closed) throw new Error("not connected");
    const { HELLO, INFO, UI } = P.msg;
    let resynced = !resync;
    for (;;) {
      const seq = this.session.next_seq();
      const got = new Promise<Answer | null>((resolve) => {
        this.waiter = { ty, seq, resolve };
        setTimeout(() => resolve(null), timeoutMs);
      });
      await this.t.write(this.session.request(ty, payload, performance.now()));
      const a = await got;
      if (this.closed) throw new Error("not connected");
      if (a) return { status: a.status, rest: new Uint8Array(a.rest) };
      this.waiter = null;
      // A frame sent just after a restart or 10 s of quiet can go to the terminal (TERM-2): a read-only request is
      // sent once more after a 0x00. Never a KEY, CMD, MORE or write: those would act twice or skip a chunk.
      if (!resynced && (ty === HELLO || ty === INFO || ty === UI)) {
        resynced = true;
        await this.t.write(this.session.take_cable(performance.now()));
        continue;
      }
      throw new TimeoutError(`No answer from the radio in ${(timeoutMs / 1000).toFixed(0)} s.`);
    }
  }

  /** A request that must succeed; `busy` is asked again for up to 3 s (a long press still held, the store busy). */
  private async okRaw(ty: number, payload: Uint8Array = new Uint8Array(), timeoutMs?: number): Promise<Uint8Array> {
    const end = performance.now() + P.timing.busy_retry_ms;
    for (;;) {
      const { status, rest } = await this.askRaw(ty, payload, timeoutMs);
      if (status === 0) return rest;
      if (status !== 7 || performance.now() > end) throw new RadioError(ty, status, rest);
      await sleep(P.timing.busy_sleep_ms);
    }
  }

  ask(ty: number, payload: Uint8Array = new Uint8Array(), timeoutMs?: number) {
    return this.exclusive(() => this.askRaw(ty, payload, timeoutMs));
  }

  ok(ty: number, payload: Uint8Array = new Uint8Array(), timeoutMs?: number) {
    return this.exclusive(() => this.okRaw(ty, payload, timeoutMs));
  }

  async hello(): Promise<Hello> {
    const h = parseHello(await this.ok(P.msg.HELLO, helloPayload(CLIENT_NAME)));
    if (!h) throw new Error("The radio's HELLO answer didn't parse.");
    return h;
  }

  /** LINK-30: the radio's PIN on Bluetooth while its PIN lock is on. */
  auth(pin: string) {
    return this.ok(P.msg.AUTH, authPayload(pin));
  }

  async info(): Promise<Info> {
    const i = parseInfo(await this.ok(P.msg.INFO));
    if (!i) throw new Error("The radio's INFO answer didn't parse.");
    return i;
  }

  /** A text answer (UI, CMD), paged with MORE, inside one `exclusive` so nothing else cuts in between pages. */
  text(ty: number, payload: Uint8Array): Promise<string> {
    return this.exclusive(async () => {
      let out = "";
      let rest = await this.okRaw(ty, payload);
      for (;;) {
        const c = parseTextChunk(rest);
        if (!c) throw new Error("A text answer didn't parse.");
        out += c.text;
        if (!c.more) return out;
        if (c.working) await sleep(P.timing.more_wait_ms);
        rest = await this.okRaw(P.msg.MORE);
      }
    });
  }

  /** What the screen shows (LINK-19's readback): 0 the state. */
  uiText(what = 0) {
    return this.text(P.msg.UI, new Uint8Array([what]));
  }

  cmd(line: string) {
    return this.text(P.msg.CMD, new TextEncoder().encode(line));
  }

  /** A keypad or side key (never PTT: the core has no name for one). A long press holds the link 800 ms after. */
  key(name: string, action: "short" | "long" | "down" | "up" = "short") {
    const p = keyPayload(name, action);
    return this.exclusive(async () => {
      await this.okRaw(P.msg.KEY, p);
      if (action === "long") this.holdUntil = performance.now() + P.timing.long_settle_ms;
    });
  }

  /** Knob steps, + clockwise; more than 20 go in several requests. */
  knob(steps: number) {
    const ps = knobPayloads(steps);
    return this.exclusive(async () => {
      for (const p of ps) await this.okRaw(P.msg.KEY, p);
    });
  }

  /**
   * LINK-11, LINK-13.3: raise the cable's rate. For each rate, best first: BAUD, then (50 ms after its answer) the
   * port switched and HELLO at the new rate within 1 s. A refusal tries the next rate; a HELLO that doesn't come
   * back puts the port back at 115200, waits out the radio's own fall-back, and HELLOs there. The rate in use.
   */
  raiseBaud(rates: number[] = P.timing.cable_fast_rates): Promise<number> {
    const t = this.t;
    if (!t.setBaud) return Promise.resolve(t.baud ?? 0);
    const { BAUD, HELLO } = P.msg;
    const { baud_switch_ms, baud_fallback_ms, cable_baud } = P.timing;
    return this.exclusive(async () => {
      for (const rate of rates) {
        const { status } = await this.askRaw(BAUD, baudPayload(rate));
        if (status !== 0) continue; // a rate this radio doesn't take
        const at = performance.now();
        await sleep(baud_switch_ms);
        await t.setBaud!(rate);
        try {
          await this.askRaw(HELLO, helloPayload(CLIENT_NAME), Math.max(200, baud_fallback_ms - (performance.now() - at) - 100), false);
          return rate;
        } catch {
          await t.setBaud!(cable_baud);
          const left = baud_fallback_ms + 300 - (performance.now() - at);
          if (left > 0) await sleep(left);
          await t.write(this.session.take_cable(performance.now()));
          await this.okRaw(HELLO, helloPayload(CLIENT_NAME));
        }
      }
      return t.baud ?? cable_baud;
    });
  }

  /**
   * LINK-11: puts the cable back at 115200 before Console lets it go, so the flasher and the terminal find the radio
   * at its default rate (a raised rate otherwise stays until the radio restarts). BAUD 115200, the port switched,
   * a HELLO there; best effort, quietly.
   */
  lowerBaud(): Promise<void> {
    const t = this.t;
    const { BAUD, HELLO } = P.msg;
    const { baud_switch_ms, cable_baud } = P.timing;
    if (!t.setBaud || (t.baud ?? cable_baud) === cable_baud || this.closed) return Promise.resolve();
    return this.exclusive(async () => {
      const { status } = await this.askRaw(BAUD, baudPayload(cable_baud), 600, false);
      if (status !== 0) return;
      await sleep(baud_switch_ms);
      await t.setBaud!(cable_baud);
      try {
        await this.askRaw(HELLO, helloPayload(CLIENT_NAME), 800, false);
      } catch {
        /* the radio falls back to 115200 by itself without it (LINK-11) */
      }
    });
  }

  /**
   * The page is going away: the BAUD 115200 request alone, written at once and not awaited. The radio switches
   * after answering, and with no HELLO stays at 115200 (LINK-11's fall-back).
   */
  releaseNow() {
    const base = P.timing.cable_baud;
    if (this.closed || !this.t.setBaud || (this.t.baud ?? base) === base) return;
    try {
      void this.t.write(this.session.request(P.msg.BAUD, baudPayload(base), performance.now()));
    } catch {
      /* gone already */
    }
  }

  /**
   * One record, read in parts of 200 bytes (LINK-21): its bytes, or null when the radio has none at that index
   * (`not found`). `busy` is asked again as for any request.
   */
  readRecord(what: number, index: number): Promise<Uint8Array | null> {
    return this.exclusive(async () => {
      const r = recordReader(what, index);
      try {
        while (!r.done()) {
          let rest: Uint8Array;
          try {
            rest = await this.okRaw(P.msg.READ, r.next_payload());
          } catch (e) {
            if (e instanceof RadioError && e.status === 8) return null;
            throw e;
          }
          if (!r.take(rest)) throw new Error("A READ answer didn't parse.");
        }
        return r.record();
      } finally {
        r.free();
      }
    });
  }

  /**
   * `run` whole-record writes from ops[i] as WRITE_MANY frames (LINK-41). Busy answers carry how many went in;
   * the rest is sent again. A refusal throws `WriteError` on the op the radio stopped at.
   */
  private async writeMany(ops: PlanOp[], i: number, run: number, progress: (done: number) => void): Promise<void> {
    let done = 0;
    const end = performance.now() + P.timing.busy_retry_ms;
    while (done < run) {
      const recs = ops.slice(i + done, i + run).map((o) => wholeRecord(o)!);
      const body = new Uint8Array(1 + recs.reduce((n, r) => n + r.entry.length, 0));
      body[0] = recs[0].what;
      let o = 1;
      for (const r of recs) {
        body.set(r.entry, o);
        o += r.entry.length;
      }
      const { status, rest } = await this.askRaw(P.msg.WRITE_MANY, body);
      const applied = rest.length ? rest[0] : 0;
      done += status === 0 ? recs.length : applied;
      progress(i + done);
      if (status === 0) continue;
      if (status === 7 && performance.now() < end) {
        await sleep(P.timing.busy_sleep_ms);
        continue;
      }
      throw new WriteError(ops[i + done], i + done, new RadioError(P.msg.WRITE_MANY, status, rest.slice(1)));
    }
  }

  /**
   * APRS contacts written (APRS-42, record 6): each a callsign (10 bytes), a name (12) and flags (bit 0 deletes),
   * added or renamed by callsign. Nine to a WRITE_MANY frame; `busy` is sent again; a refusal throws with its reason.
   */
  writeContacts(recs: Uint8Array[]): Promise<void> {
    return this.exclusive(async () => {
      for (let i = 0; i < recs.length; ) {
        const part = recs.slice(i, i + 9);
        const body = new Uint8Array(1 + part.length * 26);
        body[0] = 6;
        part.forEach((r, k) => {
          body.set([0xff, 0xff, 23], 1 + k * 26);
          body.set(r, 4 + k * 26);
        });
        const end = performance.now() + P.timing.busy_retry_ms;
        for (;;) {
          const { status, rest } = await this.askRaw(P.msg.WRITE_MANY, body);
          if (status === 0) break;
          if (status === 7 && performance.now() < end) {
            await sleep(P.timing.busy_sleep_ms);
            continue;
          }
          throw new RadioError(P.msg.WRITE_MANY, status, rest.slice(1));
        }
        i += part.length;
      }
    });
  }

  /**
   * Every record of `what` held at indexes first..end, several whole records an answer (READ_MANY, LINK-40), as a
   * map index → bytes. `progress(at)` with the index it has reached.
   */
  readMany(what: number, first: number, end: number, progress?: (at: number) => void): Promise<Map<number, Uint8Array>> {
    return this.exclusive(async () => {
      const out = new Map<number, Uint8Array>();
      let at = first;
      while (at < end) {
        const p = new Uint8Array(5);
        const v = new DataView(p.buffer);
        p[0] = what;
        v.setUint16(1, at, true);
        v.setUint16(3, Math.min(end - at, 0xffff), true);
        const a = await this.okRaw(P.msg.READ_MANY, p);
        const d = new DataView(a.buffer, a.byteOffset, a.byteLength);
        const next = d.getUint16(0, true);
        let o = 2;
        while (o + 3 <= a.length) {
          const i = d.getUint16(o, true);
          const n = a[o + 2];
          out.set(i, a.slice(o + 3, o + 3 + n));
          o += 3 + n;
        }
        if (next <= at) break; // the radio's last index
        at = next;
        progress?.(at);
      }
      return out;
    });
  }

  /** LINK-46: SUBSCRIBE (mask 0 ends it); `renew` keeps it as it is (a keepalive). The dictionary version. */
  async subscribe(mask: number, renew = false): Promise<number> {
    const rest = await this.ok(P.msg.SUBSCRIBE, subscribePayload(mask, 0, renew));
    return rest[1] ?? 0;
  }

  /** LINK-44: the whole heard list, newest first, paged by index. */
  heard(): Promise<{ count: number; stations: Station[] }> {
    return this.exclusive(async () => {
      const stations: Station[] = [];
      let count = 0;
      for (;;) {
        const h = parseHeard(await this.okRaw(P.msg.HEARD, new Uint8Array([Math.min(stations.length, 255)])));
        if (!h) throw new Error("A HEARD answer didn't parse.");
        count = h.count;
        stations.push(...h.stations);
        if (!h.stations.length || stations.length >= count || stations.length >= 255) return { count, stations };
      }
    });
  }

  /** LINK-44: every message in and out, newest first, paged by index. */
  msgs(): Promise<{ count: number; messages: Message[] }> {
    return this.exclusive(async () => {
      const messages: Message[] = [];
      let count = 0;
      for (;;) {
        const p = new Uint8Array([messages.length & 0xff, messages.length >> 8]);
        const m = parseMsgs(await this.okRaw(P.msg.MSGS, p));
        if (!m) throw new Error("A MSGS answer didn't parse.");
        count = m.count;
        messages.push(...m.messages);
        if (!m.messages.length || messages.length >= count) return { count, messages };
      }
    });
  }

  /**
   * LINK-45: an APRS message queued as the radio's compose queues it; it goes by the radio's own TX rules. True
   * when APRS mode is on (it goes at the next turn), false when it waits for APRS mode.
   */
  async msgSend(to: string, text: string): Promise<boolean> {
    const rest = await this.ok(P.msg.MSG_SEND, msgSendPayload(to, text));
    return rest[0] === 1;
  }

  /**
   * LINK-49 (APRS-13.1): one of ours still being tried stops, kept as cancelled. Firmware from before it answers
   * `unknown type`.
   */
  async msgStop(to: string, text: string): Promise<void> {
    await this.ok(P.msg.MSG_STOP, msgSendPayload(to, text));
  }

  /**
   * LINK-42: the event log, newest first, every page (below `before`; 0xFFFFFFFF from the newest). `progress` with
   * the records so far.
   */
  log(progress?: (n: number) => void): Promise<{ next: number; held: number; records: LogRecord[] }> {
    return this.exclusive(async () => {
      const records: LogRecord[] = [];
      let before = 0xffffffff;
      let next = 0;
      let held = 0;
      for (let pages = 0; pages < 500; pages++) {
        const p = parseLogPage(await this.okRaw(P.msg.LOG_READ, logReadPayload(before)));
        if (!p) throw new Error("A LOG_READ answer didn't parse.");
        if (pages === 0) [next, held] = [p.next, p.held];
        if (!p.records.length) break;
        records.push(...p.records);
        progress?.(records.length);
        before = p.records[p.records.length - 1].seq;
        if (records.length >= p.held || before === 0) break;
      }
      return { next, held, records };
    });
  }

  /**
   * A write session (LINK-9): BEGIN with the count, each op's WRITE parts or DELETE in order, then END, whatever
   * happened, all in one `exclusive` so nothing cuts in. Stops at the first refusal, which it throws with the op it
   * was on; `progress(done)` after each op.
   */
  writeSession(begin: Uint8Array, ops: PlanOp[], progress: (done: number) => void): Promise<void> {
    return this.exclusive(async () => {
      await this.okRaw(P.msg.BEGIN, begin);
      try {
        for (let i = 0; i < ops.length; ) {
          // LINK-41: channel and zone writes go as WRITE_MANY, several to a frame; deletes and the settings record
          // (bigger than a frame) as before.
          const run = manyRun(ops, i);
          if (run > 0) {
            await this.writeMany(ops, i, run, progress);
            i += run;
            continue;
          }
          const op = ops[i];
          for (const p of op.payloads) {
            try {
              await this.okRaw(op.msg, new Uint8Array(p));
            } catch (e) {
              throw new WriteError(op, i, e as Error);
            }
          }
          i++;
          progress(i);
        }
      } finally {
        try {
          await this.okRaw(P.msg.END);
        } catch {
          /* the session also ends by itself after 5 s */
        }
      }
    });
  }
}

/** A WRITE whose record fits one part: [what, index, offset 0, total, bytes] with the whole record in it. */
function wholeRecord(op: PlanOp): { what: number; entry: Uint8Array } | null {
  if (op.kind !== "write" || op.msg !== P.msg.WRITE || op.payloads.length !== 1) return null;
  const p = op.payloads[0];
  const off = p[3] | (p[4] << 8);
  const total = p[5] | (p[6] << 8);
  if ((p[0] !== 2 && p[0] !== 3) || off !== 0 || total !== p.length - 7 || total > 255) return null;
  return { what: p[0], entry: new Uint8Array([p[1], p[2], total, ...p.slice(7)]) };
}

/** How many ops from `i` go in one WRITE_MANY frame (MAX_PAYLOAD 240: the what byte, then index, length, record). */
function manyRun(ops: PlanOp[], i: number): number {
  const first = wholeRecord(ops[i]);
  if (!first) return 0;
  let size = 1;
  let n = 0;
  for (let k = i; k < ops.length; k++) {
    const r = wholeRecord(ops[k]);
    if (!r || r.what !== first.what || size + r.entry.length > 240) break;
    size += r.entry.length;
    n++;
  }
  return n;
}

/** A write session stopped at an op: which, how many went before it, and the radio's reason. */
export class WriteError extends Error {
  constructor(
    readonly op: PlanOp,
    readonly done: number,
    readonly reason: Error,
  ) {
    super(`${op.what} ${op.number}: ${reason instanceof RadioError && reason.status === 10 ? "cancelled on the radio (BACK)" : reason.message}`);
  }
}
