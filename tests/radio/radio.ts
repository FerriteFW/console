// The radio journey's shared parts: which radio (radios.toml), the oracle (the radio over its Bluetooth, oracle.py),
// the run's start snapshot, and `test` with the oracle as a worker fixture. Console itself is opened and connected
// with the e2e helpers (tests/e2e/helpers.ts): the same steps, the bridge on the radio's cable.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test as e2e } from "../e2e/helpers";

export { expect } from "../e2e/helpers";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const ferriteDir = process.env.FERRITE_DIR ?? join(root, "..", "ferrite");
export const runDir = join(root, "test-results", "radio-run");
export const python = () => {
  const venv = join(root, "..", ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
};

export type RadioConf = { name: string; cable: string; ble: string; build: string; backup: string };

/** FERRITE_RADIO (default: radios.toml's default) from ~/.config/ferrite/radios.toml; the cable is the one CH340
 *  plugged in (FERRITE_RADIO_SERIAL to name it). Only a radio with `cable = true` and a Bluetooth ID will do. */
export function radioConf(): RadioConf {
  // FERRITE_RADIO=sim: a headless simulator (setup.ts starts it), checked over its Bluetooth side, to try the stages
  // without a radio. The stages that flash skip there.
  if (process.env.FERRITE_RADIO === "sim")
    return { name: "sim", cable: "", ble: process.env.FERRITE_RADIO_ORACLE ?? "", build: "", backup: "" };
  const path = join(homedir(), ".config", "ferrite", "radios.toml");
  const toml = existsSync(path) ? readFileSync(path, "utf8") : "";
  const name = process.env.FERRITE_RADIO ?? /^default\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? "black";
  const block = new RegExp(`\\[radios\\.${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(toml)?.[1] ?? "";
  const field = (k: string) => new RegExp(`^${k}\\s*=\\s*"?([^"\\n]*)"?`, "m").exec(block)?.[1]?.trim() ?? "";
  if (!block) throw new Error(`no [radios.${name}] in ${path}`);
  if (field("cable") !== "true") throw new Error(`${name}: radios.toml says it isn't on the cable (cable = true)`);
  const ble = field("ble");
  if (!ble) throw new Error(`${name}: no Bluetooth ID in radios.toml (the journey checks the radio over Bluetooth)`);
  const ports = readdirSync("/dev").filter((f) => f.startsWith("cu.usbserial-"));
  const cable = process.env.FERRITE_RADIO_SERIAL ?? (ports.length === 1 ? `/dev/${ports[0]}` : "");
  if (!cable) throw new Error(`plug in the cable, or name it in FERRITE_RADIO_SERIAL (found: ${ports.join(", ") || "none"})`);
  return { name, cable, ble: `ble:${ble}`, build: field("build"), backup: field("backup").replace(/^~/, homedir()) };
}

/** The radio over its Bluetooth, one session for the run (oracle.py): reads, and keys pressed; never a write. */
export class Oracle {
  private proc: ChildProcess;
  private lines: Interface;
  private waiting: ((line: string) => void)[] = [];
  private ready: Promise<void>;
  private err = "";

  constructor(ble: string) {
    this.proc = spawn(python(), [join(root, "tests", "radio", "oracle.py"), ble], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FERRITE_DIR: ferriteDir },
    });
    this.proc.stderr!.on("data", (d) => (this.err = (this.err + d).slice(-2000)));
    this.lines = createInterface({ input: this.proc.stdout! });
    this.lines.on("line", (l) => this.waiting.shift()?.(l));
    this.ready = new Promise((ok, no) => {
      this.waiting.push((l) => (JSON.parse(l).ready ? ok() : no(new Error(`oracle: ${l}`))));
      this.proc.on("exit", (code) => no(new Error(`oracle ended (${code}): ${this.err}`)));
    });
  }

  async ask<T>(q: Record<string, unknown>, ms = 90_000): Promise<T> {
    await this.ready;
    const line = await new Promise<string>((ok, no) => {
      const t = setTimeout(() => no(new Error(`oracle: no answer to ${JSON.stringify(q)} in ${ms / 1000} s; ${this.err}`)), ms);
      this.waiting.push((l) => (clearTimeout(t), ok(l)));
      this.proc.stdin!.write(JSON.stringify(q) + "\n");
    });
    const a = JSON.parse(line);
    if ("error" in a) throw new Error(`oracle ${JSON.stringify(q)}: ${a.error}`);
    return a.ok as T;
  }

  hello = () => this.ask<{ firmware: string; build: string; bench: boolean }>({ do: "hello" });
  used = (what: "channel" | "zone" | "preset") => this.ask<number[]>({ do: "used", what });
  channel = (n: number) => this.ask<{ n: number; name: string; rx: number; zone: number | null; hex: string } | null>({ do: "channel", n });
  record = (what: "zone" | "preset", n: number) => this.ask<string | null>({ do: "record", what, n });
  settings = () => this.ask<string>({ do: "settings" });
  ui = () => this.ask<string>({ do: "ui" });
  /** The radio's own `get` line for a menu number ("0 7 5 1 Key beep: On"). */
  get = (id: string) => this.ask<string>({ do: "get", id });
  keys = (keys: string) => this.ask<null>({ do: "keys", keys });

  close() {
    this.proc.stdin!.end();
    setTimeout(() => this.proc.kill(), 3000).unref();
  }
}

/** What the radio held when the run began (setup.ts), for the last stage's comparison. */
export type Snapshot = { firmware: string; build: string; channels: number[]; zones: number[]; presets: number[]; settings: string };
export const startSnapshot = (): Snapshot => JSON.parse(readFileSync(join(runDir, "start.json"), "utf8"));

export const test = e2e.extend<{}, { oracle: Oracle; radio: RadioConf }>({
  radio: [async ({}, use) => use(radioConf()), { scope: "worker" }],
  oracle: [
    async ({ radio }, use) => {
      const o = new Oracle(radio.ble);
      try {
        await use(o);
      } finally {
        o.close();
      }
    },
    { scope: "worker" },
  ],
});

/** The settings record's bytes that differ, as "offset: was -> now" (hex). */
export function byteDiff(a: string, b: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 2) {
    if (a.slice(i, i + 2) !== b.slice(i, i + 2)) out.push(`${i / 2}: ${a.slice(i, i + 2) || "--"} -> ${b.slice(i, i + 2) || "--"}`);
  }
  return out;
}
