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
  parseHello,
  parseInfo,
  parseTextChunk,
  statusText,
  type Answer,
  type Hello,
  type Info,
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

  constructor(readonly t: Transport) {
    t.onData = (bytes) => {
      if (this.closed) return;
      const answers: Answer[] = JSON.parse(this.session.feed(bytes));
      for (const a of answers) {
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
}
