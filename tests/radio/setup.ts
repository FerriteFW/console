// Before the journey: which radio and cable, a look at the radio over Bluetooth (its firmware and what it holds, kept
// in test-results/radio-run/start.json for the last stage), then the bridge on its cable for Console.
// Refuses a radio whose build isn't the one radios.toml names, so a run never edits the wrong radio.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBridge } from "../e2e/procs";
import { Oracle, radioConf, runDir, type Snapshot } from "./radio";

const BUILDS: Record<string, string> = { "tx-bench": "tx+dry", tx: "tx", receive: "receive" };

export default async function setup() {
  const radio = radioConf();
  console.log(`radio journey: ${radio.name} on ${radio.cable}, checked over ${radio.ble}`);
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
  console.log(`  ${snap.firmware} ${snap.build}: ${snap.channels.length} channels, ${snap.zones.length} zones, ${snap.presets.length} presets`);
  process.env.FERRITE_E2E_TARGET = "radio";
  if (process.env.FERRITE_E2E_BRIDGE) return;
  const b = await startBridge(radio.cable);
  process.env.FERRITE_E2E_BRIDGE = b.url;
  return async () => b.stop();
}
