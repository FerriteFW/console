// The SPI parts of an update file, `.ffw` (ferrite decision 335, UPD-21): once the new firmware runs, its parts go
// over the cable's raw writes (LINK-59 – LINK-62) as the core plans them (core/src/ffw.rs `write_plan`): each part's
// sectors erased, its bytes programmed, read back by CRC; then the layout stamp, on which the radio restarts. Console
// then asks for HELLO until the radio answers on its layout again. The plan never touches calibration, the update
// area, the layout header or the migration mark: the core refused any part aimed there before anything was written.
import { P, type FfwFile } from "./core";
import { Link, TimeoutError } from "./link";
import { sleep, type Transport } from "./transport/types";

/** After the stamp: the radio restarts; HELLO until this runs out. */
const RESTART_WAIT_MS = 40_000;

export type PartsProgress = (message: string, done: number, total: number) => void;

/**
 * Writes `ffw`'s parts over `link` (the cable, open, past HELLO), then waits for the radio to come back on `t`.
 * `held` throws when the cable went away.
 */
export async function writeParts(t: Transport, link: Link, ffw: FfwFile, progress: PartsProgress, held: () => void): Promise<void> {
  const n = ffw.len();
  for (let i = 0; i < n; i++) {
    held();
    const kind = ffw.kind(i);
    progress(kind === "stamp" ? "Stamping: the radio restarts with its parts…" : `Writing ${ffw.region(i).replace(/^spi\//, "")}`, i, n);
    if (kind === "stamp") {
      // Taken once the radio has written everything before it (`busy` until then, asked again); its answer may not
      // get out before the restart.
      try {
        await link.data(P.msg.DATA_WRITE, ffw.payload(i), 3000);
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
      }
      break;
    }
    const rest = await link.data(ffw.msg(i), ffw.payload(i));
    const want = ffw.expect(i);
    if (want >= 0) {
      const got = new DataView(rest.buffer, rest.byteOffset).getUint32(0, true);
      if (got !== want >>> 0) throw new Error(`${ffw.region(i)} read back differently: write the parts again (the firmware works without them meanwhile).`);
    }
  }
  progress("The radio restarts with its parts; connecting again…", n, n);
  link.close();
  await sleep(1000);
  if (t.setBaud) await t.setBaud(P.timing.cable_baud);
  const end = performance.now() + RESTART_WAIT_MS;
  for (;;) {
    held();
    const probe = new Link(t);
    try {
      await probe.open();
      const h = await probe.hello();
      probe.close();
      if (h.layouts && h.layouts.chip !== h.layouts.firmware) throw new Error(`The radio restarted with its data in layout ${h.layouts.chip}: open Finish the update.`);
      return;
    } catch (e) {
      probe.close();
      if (!(e instanceof TimeoutError)) throw e;
      if (performance.now() > end) throw new Error(`The radio didn't answer in ${RESTART_WAIT_MS / 1000} s after its restart. Check its screen; connect again by hand.`);
    }
  }
}
