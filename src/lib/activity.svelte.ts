// The Activity Log's state: the radio's event log (LOG_READ, LINK-42) read whole, newest first, each record dated
// from its age at the read (the radio's clock may have no date). Filters and the CSV are the page's and the core's.
import { logCsv, type LogRecord } from "./core";
import { download, stamp } from "./channels.svelte";
import { RadioError } from "./link";
import { radio } from "./radio.svelte";

export type LogRow = LogRecord & { at: number };

class Activity {
  rows = $state<LogRow[]>([]);
  held = $state(0);
  busy = $state("");
  error = $state("");
  readAt = $state(0);
  private forLink: unknown = null;

  ensure() {
    const link = radio.connectedLink;
    if (link && this.forLink !== link && !this.busy) void this.refresh();
  }

  async refresh() {
    const link = radio.connectedLink;
    if (!link) return;
    this.forLink = link;
    this.error = "";
    this.busy = "Reading the event log";
    try {
      const now = Date.now();
      const p = await link.log((n) => (this.busy = `Reading the event log: ${n}`));
      this.rows = p.records.map((r) => ({ ...r, at: now - r.ago_s * 1000 }));
      this.held = p.held;
      this.readAt = now;
    } catch (e) {
      this.error = e instanceof RadioError && e.status === 2 ? "This radio's firmware has no event log over the link yet (LINK-42): update it." : (e as Error).message;
      this.forLink = null;
    } finally {
      this.busy = "";
    }
  }

  /** The rows shown (`rows`, filtered) as a CSV download, dated in local time. */
  csv(rows: LogRow[]) {
    const times = rows.map((r) => new Date(r.at).toLocaleString());
    const strip = rows.map(({ at: _at, ...r }) => r);
    const who = (radio.info?.callsign || "radio").replace(/[^A-Za-z0-9-]/g, "");
    download(`ferrite-${who}-${stamp()}-activity.csv`, logCsv(strip, times), "text/csv");
  }
}

export const activity = new Activity();
