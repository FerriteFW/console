// Before the run: on the simulator (the default), builds ferrite-sim if needed; each worker then starts its own
// simulator and bridge (helpers.ts). On the radio (FERRITE_E2E_SERIAL names its cable), starts the one bridge, unless
// FERRITE_E2E_BRIDGE names a bridge already running. The bridge's URL goes to the tests as FERRITE_E2E_BRIDGE;
// FERRITE_E2E_TARGET is "sim" or "radio".
import { buildSim, startBridge } from "./procs";

export default async function setup() {
  const serial = process.env.FERRITE_E2E_SERIAL;
  process.env.FERRITE_E2E_TARGET = serial ? "radio" : "sim";
  if (serial && !process.env.FERRITE_E2E_CHANNEL)
    throw new Error("FERRITE_E2E_CHANNEL: name a scratch channel (its number) the write tests may edit and put back");
  if (process.env.FERRITE_E2E_BRIDGE) return; // a bridge already running
  if (!serial) return buildSim();
  const b = await startBridge(serial);
  process.env.FERRITE_E2E_BRIDGE = b.url;
  return async () => b.stop();
}
