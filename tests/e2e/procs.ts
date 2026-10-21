// The processes the tests talk to: a headless simulator (from ../ferrite) and the bridge in front of it or of the
// radio's cable, each on a free port. global-setup builds the simulator and starts the cable's bridge; each worker
// starts its own simulator and bridge (helpers.ts), so tests on two workers never share a radio.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ferrite = fileURLToPath(new URL("../../../ferrite", import.meta.url));
const simExe = `${ferrite}/target/debug/ferrite-sim`;

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

/** Builds ferrite-sim when it is missing (or FERRITE_E2E_BUILD_SIM is set). */
export function buildSim() {
  if (existsSync(simExe) && !process.env.FERRITE_E2E_BUILD_SIM) return;
  const b = spawnSync("cargo", ["build", "-q", "-p", "ferrite-sim"], { cwd: ferrite, stdio: "inherit" });
  if (b.status !== 0) throw new Error("cargo build -p ferrite-sim failed");
}

/** Starts the bridge (and, without `serial`, a simulator behind it). Returns its ws:// URL and a stop function. */
/** On the simulator the bridge also runs the fake bootloader (tools/fakeboot.py), its mode file in `fakeboot`. */
export async function startBridge(serial?: string): Promise<{ url: string; stop: () => void; fakeboot?: string }> {
  const procs: ChildProcess[] = [];
  const stop = () => {
    for (const p of procs.reverse()) p.kill();
  };
  try {
    let target: string[];
    let fakeboot: string | undefined;
    if (serial) {
      target = ["--serial", serial];
    } else {
      const simPort = await freePort();
      const sim = spawn(simExe, ["--term-headless", "3600", "--term-tcp", String(simPort)], { stdio: ["ignore", "pipe", "pipe"] });
      procs.push(sim);
      await waitFor(sim, /nc 127\.0\.0\.1/, "the simulator");
      fakeboot = join(mkdtempSync(join(tmpdir(), "ferrite-fakeboot-")), "mode.json");
      target = ["--tcp", `127.0.0.1:${simPort}`, "--fakeboot", fakeboot];
    }
    const wsPort = await freePort();
    const bridge = spawn(python(), [`${root}/tools/bridge.py`, ...target, "--port", String(wsPort)], { stdio: ["ignore", "pipe", "pipe"] });
    procs.push(bridge);
    await waitFor(bridge, /ws:\/\/127\.0\.0\.1/, "the bridge");
    return { url: `ws://127.0.0.1:${wsPort}`, stop, fakeboot };
  } catch (e) {
    stop();
    throw e;
  }
}
