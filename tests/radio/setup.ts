// Before the journey: which radio and cable, a look at the radio over Bluetooth (its firmware and what it holds, kept
// in test-results/radio-run/start.json for the last stage), then the bridge on its cable for Console.
// Refuses a radio whose build isn't the one radios.toml names, so a run never edits the wrong radio.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSim, startBridge } from "../e2e/procs";
import { ferriteDir, Oracle, python, radioConf, runDir, restoredMark, stockMark, type Snapshot } from "./radio";

const BUILDS: Record<string, string> = { "tx-bench": "tx+dry", tx: "tx", receive: "receive" };

export default async function setup() {
  let stopSim: (() => void) | null = null;
  if (process.env.FERRITE_RADIO === "sim") {
    buildSim();
    const b = await startBridge();
    stopSim = b.stop;
    process.env.FERRITE_E2E_BRIDGE = b.url;
    // Bluetooth on (MENU 0 9 2 1) over the cable before Console holds it; the oracle then uses the Bluetooth side.
    const on = spawnSync(python(), [`${ferriteDir}/tools/ferrite_link.py`, `tcp:127.0.0.1:${b.ports!.term}`, "term", "set 0 9 2 1 On"], { encoding: "utf8" });
    if (on.status !== 0) throw new Error(`simulator Bluetooth on: ${on.stdout}${on.stderr}`);
    process.env.FERRITE_RADIO_ORACLE = `tcp:127.0.0.1:${b.ports!.bt}`;
  }
  const radio = radioConf();
  console.log(`radio journey: ${radio.name} on ${radio.cable}, checked over ${radio.ble}`);
  // Mid stock round (stage 60 ran, stage 85 not yet): the radio is on stock, or on Ferrite with stock's data, so the
  // run keeps the start it took before.
  if (existsSync(stockMark())) {
    if (!existsSync(join(runDir, "start.json"))) throw new Error(`the radio is on stock but ${runDir} has no start.json`);
    console.log("  mid stock round (stages 60-85): keeping the run's start.json");
    process.env.FERRITE_E2E_TARGET = "radio";
    if (process.env.FERRITE_E2E_BRIDGE) return;
    const b = await startBridge(radio.cable);
    process.env.FERRITE_E2E_BRIDGE = b.url;
    return async () => b.stop();
  }
  const o = new Oracle(radio.ble);
  let snap: Snapshot;
  try {
    const h = await o.hello();
    const want = BUILDS[radio.build];
    if (want && h.build !== want && !process.env.FERRITE_RADIO_ANY_BUILD)
      throw new Error(`${radio.name} answers build ${h.build}, radios.toml says ${radio.build}: the wrong radio? (FERRITE_RADIO_ANY_BUILD=1 to run anyway)`);
    snap = {
      firmware: h.firmware,
      build: h.build,
      channels: await o.used("channel"),
      zones: await o.used("zone"),
      presets: await o.used("preset"),
      settings: await o.settings(),
    };
  } finally {
    o.close();
  }
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "start.json"), JSON.stringify(snap, null, 1));
  rmSync(restoredMark(), { force: true }); // a new start: no stock round behind it yet
  console.log(`  ${snap.firmware} ${snap.build}: ${snap.channels.length} channels, ${snap.zones.length} zones, ${snap.presets.length} presets`);
  process.env.FERRITE_E2E_TARGET = "radio";
  if (stopSim) return async () => stopSim!();
  if (process.env.FERRITE_E2E_BRIDGE) return;
  const b = await startBridge(radio.cable);
  process.env.FERRITE_E2E_BRIDGE = b.url;
  return async () => b.stop();
}
