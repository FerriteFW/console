// Starts what the tests talk to: a headless simulator (unless FERRITE_E2E_SERIAL names the radio's cable) and the
// bridge in front of it, on free ports, unless FERRITE_E2E_BRIDGE names a bridge already running. The bridge's URL
// goes to the tests as FERRITE_E2E_BRIDGE; FERRITE_E2E_TARGET is "sim" or "radio". On the simulator the bridge also
// runs the fake bootloader (tools/fakeboot.py); its mode file is FERRITE_E2E_FAKEBOOT.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ferrite = fileURLToPath(new URL("../../../ferrite", import.meta.url));

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
    s.on("error", fail);
  });

/** Waits until the process prints `want` (on stdout or stderr). */
const waitFor = (p: ChildProcess, want: RegExp, what: string, ms = 15_000) =>
  new Promise<void>((ok, fail) => {
    let seen = "";
    const timer = setTimeout(() => fail(new Error(`${what} didn't start: ${seen}`)), ms);
    const look = (b: Buffer) => {
      seen += b.toString();
      if (process.env.FERRITE_E2E_VERBOSE) process.stderr.write(b);
      if (want.test(seen)) {
        clearTimeout(timer);
        ok();
      }
    };
    p.stdout?.on("data", look);
    p.stderr?.on("data", look);
    p.on("exit", (c) => fail(new Error(`${what} exited (${c}): ${seen}`)));
  });

function python(): string {
  if (process.env.FERRITE_PYTHON) return process.env.FERRITE_PYTHON;
  const venv = fileURLToPath(new URL("../../../.venv/bin/python", import.meta.url));
  return existsSync(venv) ? venv : "python3";
}

export default async function setup() {
  const serial = process.env.FERRITE_E2E_SERIAL;
  process.env.FERRITE_E2E_TARGET = serial ? "radio" : "sim";
  if (serial && !process.env.FERRITE_E2E_CHANNEL)
    throw new Error("FERRITE_E2E_CHANNEL: name a scratch channel (its number) the write tests may edit and put back");
  if (process.env.FERRITE_E2E_BRIDGE) return; // a bridge already running
  const procs: ChildProcess[] = [];
  let target: string[];
  if (serial) {
    target = ["--serial", serial];
  } else {
    const exe = `${ferrite}/target/debug/ferrite-sim`;
    if (!existsSync(exe) || process.env.FERRITE_E2E_BUILD_SIM) {
      const b = spawnSync("cargo", ["build", "-q", "-p", "ferrite-sim"], { cwd: ferrite, stdio: "inherit" });
      if (b.status !== 0) throw new Error("cargo build -p ferrite-sim failed");
    }
    const simPort = await freePort();
    const sim = spawn(exe, ["--term-headless", "3600", "--term-tcp", String(simPort)], { stdio: ["ignore", "pipe", "pipe"] });
    procs.push(sim);
    await waitFor(sim, /nc 127\.0\.0\.1/, "the simulator");
    const mode = join(mkdtempSync(join(tmpdir(), "ferrite-fakeboot-")), "mode.json");
    process.env.FERRITE_E2E_FAKEBOOT = mode;
    target = ["--tcp", `127.0.0.1:${simPort}`, "--fakeboot", mode];
  }
  const wsPort = await freePort();
  const bridge = spawn(python(), [`${root}/tools/bridge.py`, ...target, "--port", String(wsPort)], { stdio: ["ignore", "pipe", "pipe"] });
  procs.push(bridge);
  await waitFor(bridge, /ws:\/\/127\.0\.0\.1/, "the bridge");
  process.env.FERRITE_E2E_BRIDGE = `ws://127.0.0.1:${wsPort}`;
  return async () => {
    for (const p of procs.reverse()) p.kill();
  };
}
