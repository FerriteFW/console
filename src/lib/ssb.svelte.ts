// SSB for a radio already on Ferrite (INST-10.2, decision 457): the patch from the owner's stock .BTF, found here on
// this computer (never sent anywhere else), then written into the radio with SSB_WRITE (ferrite LINK-73) over its
// usual connection: the cable, or Bluetooth past the PIN. The radio checks it (length, records, SHA-256) before it
// counts as held and uses it at once, no restart. Only the known stock patch goes; nothing of it is logged.
import { P, ssbExtract, ssbWritePlan } from "./core";
import { debugLog } from "./debuglog";
import { RadioError } from "./link";
import { radio } from "./radio.svelte";

const CHECK = 3;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

class Ssb {
  /** Whether the connected radio holds a verified patch; null not asked yet, or a Ferrite without SSB_WRITE. */
  held = $state<boolean | null>(null);
  /** The radio's Ferrite has no SSB_WRITE (before 0.9.8): Add SSB needs an update first. */
  tooOld = $state(false);
  /** Pieces sent of `total` while adding; total 0 when not adding. */
  done = $state(0);
  total = $state(0);
  error = $state("");
  notice = $state("");

  /** `CHECK`: the held patch's SHA-256 (hex), "" for none. */
  private async check(): Promise<string> {
    const link = radio.connectedLink;
    if (!link) throw new Error("the radio isn't connected");
    const r = await link.data(P.msg.SSB_WRITE, new Uint8Array([CHECK]));
    return r[0] === 1 ? hex(r.subarray(1, 33)) : "";
  }

  /** Asks the connected radio whether it holds the patch (cheap: the radio answers from what it checked). */
  async refresh() {
    if (!radio.connectedLink || this.total) return;
    try {
      this.held = (await this.check()) !== "";
      this.tooOld = false;
    } catch (e) {
      this.held = null;
      this.tooOld = e instanceof RadioError && e.status === 2;
    }
  }

  forget() {
    [this.held, this.tooOld, this.error, this.notice] = [null, false, "", ""];
  }

  /** Add SSB…: the owner's stock .BTF, the patch found in it here, sent to the radio, then checked. */
  async add(file: File) {
    const link = radio.connectedLink;
    this.error = this.notice = "";
    if (!link) return void (this.error = "Connect the radio first.");
    const patch = ssbExtract(new Uint8Array(await file.arrayBuffer()));
    if (!patch) return void (this.error = `No SSB patch in ${file.name}. Choose the stock firmware file (.BTF) from the radio maker's website.`);
    const plan = ssbWritePlan(patch);
    if (!plan) return void (this.error = `${file.name} has an SSB patch, but not the one Ferrite knows, so Console won't send it. Try another stock version.`);
    const sha = plan[0].subarray(5, 37);
    radio.busy = "Adding SSB";
    [this.done, this.total] = [0, plan.length];
    try {
      const begin = await link.data(P.msg.SSB_WRITE, plan[0]);
      this.done = 1;
      if (begin[0] === 1) {
        this.held = true;
        this.notice = "The radio already has SSB. Nothing was written.";
        return;
      }
      for (const p of plan.slice(1)) {
        await link.data(P.msg.SSB_WRITE, p);
        this.done++;
      }
      const got = await this.check();
      this.held = got !== "";
      if (got !== hex(sha)) throw new Error("the radio's check of it failed: add it again");
      debugLog(`ssb: added over the link, ${patch.length / 8} records`);
      this.notice = "SSB added and checked. USB, LSB and CW are in HF mode now.";
    } catch (e) {
      const tooOld = e instanceof RadioError && e.status === 2;
      this.tooOld ||= tooOld;
      this.error = tooOld ? "This radio's Ferrite can't take SSB over the link yet: update it first, then add SSB." : `SSB didn't go in: ${(e as Error).message}. USB, LSB and CW stay hidden until it does.`;
      debugLog(`ssb: add failed: ${(e as Error).message}`);
    } finally {
      [this.done, this.total] = [0, 0];
      radio.busy = "";
    }
    if (this.error && !this.tooOld) await this.refresh(); // a write cut after its begin leaves none held
  }
}

export const ssb = new Ssb();
