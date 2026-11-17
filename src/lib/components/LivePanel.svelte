<script lang="ts">
  // Live View's side panel (Alex approved the mockup, Oct 30): beside the radio on a wide window, what the screen
  // can't fit at once. Slots (the radio state, LINK-67, on any screen, with the tuning commands, LINK-68; from an
  // older radio the readback's cards, home only), Heard now (the APRS card's rows, the heard list and the event
  // log, whichever Console has already read, and the event log's new events as they happen: LINK-57), Radio (the
  // status bar and INFO), Listen. Nothing here reads the radio by itself: it shows what Console already has, and
  // what the radio sends.
  import { P, type Kv, type SlotNow } from "../core";
  import { radio } from "../radio.svelte";
  import { listen } from "../listen.svelte";
  import { aprs, ago, atKey } from "../aprs.svelte";
  import { activity } from "../activity.svelte";

  let { hearing }: { hearing: string } = $props();

  // The event log's new events while the panel is up (a radio that sends them: LINK-57).
  $effect(() => activity.use());

  const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
  const slotColour: Record<string, string> = { A: "var(--blue)", B: "var(--amber)", C: "var(--violet)" };
  /** "145.49500" -> "145.495", "98.10000" -> "98.1". */
  const mhz = (f: unknown) => s(f).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

  const connected = $derived(radio.phase === "connected");
  const ui = $derived(connected ? radio.ui : null);

  // The cards come on home only: the last ones seen stay while another screen is up (gone with the connection).
  let cards = $state<Kv[]>([]);
  $effect(() => {
    if (!connected) cards = [];
    else if (ui && ui.cards.length) cards = ui.cards;
  });
  const onHome = $derived(!!ui && ui.cards.length > 0);

  // LINK-67: the radio state while the panel is up, from a radio that sends it; its slots on any screen.
  $effect(() => (connected ? radio.want("live-panel", P.event.SUB_STATE) : undefined));
  const now = $derived(connected ? radio.now : null);
  const hzText = (hz: number) => mhz((hz / 1e6).toFixed(5));
  function nowMain(x: SlotNow): string {
    if (x.broadcast) return [x.name, `${(x.hz / 1e6).toFixed(1)} MHz`].filter(Boolean).join(" · ");
    return x.name ? `${x.name} · ${hzText(x.hz)}` : hzText(x.hz);
  }
  function nowDetail(x: SlotNow): string {
    if (x.aprs) return "APRS";
    if (x.broadcast) return "Broadcast";
    return [x.on_channel ? `Ch ${x.channel}` : "VFO", x.mode, x.power].filter(Boolean).join(" · ");
  }
  function nowStatus(x: SlotNow): { text: string; tone: string } {
    if (x.transmitting) return { text: "TX", tone: "tx" };
    if (x.off) return { text: "off", tone: "" };
    if (x.scanning) return { text: x.open ? "scan · RX" : "scanning", tone: x.open ? "rx" : "busy" };
    if (x.open) return { text: x.dbm !== null ? `RX ${x.dbm} dBm` : "RX", tone: "rx" };
    if (x.broadcast) return { text: x.muted ? "muted" : "FM", tone: x.muted ? "warn" : "" };
    if (x.muted) return { text: "muted", tone: "warn" };
    return { text: x.aprs ? "APRS" : "idle", tone: "" };
  }
  // LINK-68: a channel typed per slot
  let chanText = $state<Record<string, string>>({});
  function goChannel(i: number, x: SlotNow, e: SubmitEvent) {
    e.preventDefault();
    const n = Number(chanText[x.slot]);
    if (Number.isInteger(n) && n >= 1) void radio.tune(i, "channel", n).then((ok) => ok && (chanText[x.slot] = ""));
  }

  function main(c: Kv): string {
    if (c.kind === "broadcast") return `${n(c.freq).toFixed(1)} MHz`;
    const f = mhz(c.freq);
    return s(c.name) ? `${s(c.name)} · ${f}` : f;
  }
  function detail(c: Kv): string {
    if (c.kind === "broadcast") return ["Broadcast", s(ui?.bcast?.[s(c.slot)]?.rds).trim()].filter(Boolean).join(" · ");
    if (c.kind === "aprs") return ["APRS", c.hour !== undefined ? `${n(c.heard)} heard · ${n(c.hour)} /hr` : `${n(c.heard)} heard`, s(c.power)].filter(Boolean).join(" · ");
    return [s(c.mode), s(c.tone), s(c.power)].filter(Boolean).join(" · ");
  }
  /** What the slot is doing: RX with its S-meter, TX, scanning, idle, off, APRS's state. */
  function status(c: Kv): { text: string; tone: string } {
    const st = s(c.hint) || s(c.state);
    if (s(c.state) === "TX") return { text: "TX", tone: "tx" };
    if (n(c.rx) || st.startsWith("RX")) return { text: `RX ${s(c.s)}`.trim(), tone: "rx" };
    if (st === "MON") return { text: "Monitor", tone: "rx" };
    if (n(c.scan) || /^scan/i.test(st)) return { text: "scanning", tone: "busy" };
    if (c.kind === "aprs") return { text: st === "Muted" ? "muted" : st && st !== "idle" ? st : "APRS", tone: st === "Muted" ? "warn" : "" };
    return { text: st || "idle", tone: st === "heard" ? "warn" : "" };
  }

  // Heard now: the APRS card's rows (live while APRS mode is on), the heard list and the event log when a page read
  // them; the newest first, one row a call.
  type Heard = { who: string; what: string; when: string; key: number };
  const heard = $derived.by(() => {
    const out: Heard[] = [];
    const now = Date.now();
    const card = ui?.other.find((l) => l.kind === "aprs_card")?.kv;
    if (card) {
      for (const k of ["r1", "r2", "r3"]) {
        const [call = "", age = "", right = ""] = s(card[k]).split("|");
        if (call) out.push({ who: call, what: ["APRS", right].filter(Boolean).join(" · "), when: age, key: now - out.length });
      }
    }
    if (aprs.loaded) {
      for (const st of aprs.stations.slice(0, 6)) {
        out.push({ who: st.call, what: ["APRS", st.symbol_name].filter(Boolean).join(" · "), when: st.at === null ? "" : ago(st.at, now), key: atKey(st.at) });
      }
    }
    for (const r of activity.rows.slice(0, 6)) {
      const who = r.name || r.text || r.source;
      if (!who) continue;
      out.push({ who, what: [r.source, r.mhz, r.slot_name].filter(Boolean).join(" · "), when: r.at === null ? "" : ago(r.at, now), key: atKey(r.at) });
    }
    const seen = new Set<string>();
    return out
      .sort((a, b) => b.key - a.key)
      .filter((h) => {
        const k = h.who.toUpperCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 5);
  });

  const bar = $derived(ui?.bar ?? null);
  const gps = $derived.by(() => {
    const g = s(bar?.gps);
    if (!g || g === "off") return { text: "off", tone: "" };
    if (g === "fix") return { text: "fix", tone: "ok" };
    return { text: g === "search" ? "searching" : g, tone: "warn" };
  });
  const bt = $derived(!bar ? "" : !n(bar.bt_on) ? "off" : n(bar.bt) ? "connected" : "on");
  const build = $derived(radio.info?.build ?? radio.hello?.build ?? null);

  const listenText = $derived(
    !connected
      ? "Off"
      : radio.kind !== "cable"
        ? "Cable only"
        : !listen.fastEnough
          ? "Needs High speed"
          : !listen.available
          ? "This firmware doesn't send receive audio"
          : listen.on
            ? `On · ${hearing}`
            : "Off",
  );
</script>

<aside class="panel" aria-label="Live View panel" data-live-panel>
  <section>
    <h4>Slots</h4>
    {#if now}
      {#each now.slots as x, i (x.slot)}
        {@const st = nowStatus(x)}
        {@const fixed = x.aprs || x.transmitting || now.transmitting}
        <div class="slot" class:active={now.active === i} data-slot={x.slot}>
          <button
            class="badge"
            style:background={slotColour[x.slot]}
            title={now.active === i ? `Slot ${x.slot} is active` : `Make slot ${x.slot} active`}
            aria-label={`Make slot ${x.slot} active`}
            disabled={now.active === i}
            onclick={() => radio.makeActive(i)}>{x.slot}</button
          >
          <span class="what">
            <span class="main">{nowMain(x)}</span>
            <span class="sub">{nowDetail(x)}</span>
          </span>
          <span class="st {st.tone}">{st.text}</span>
          <div class="tune" role="group" aria-label={`Tune slot ${x.slot}`}>
            <button title="Down a step or channel (▼)" aria-label="Down" disabled={fixed || x.scanning} onclick={() => radio.tune(i, "step", -1)}>▼</button>
            <button title="Up a step or channel (▲)" aria-label="Up" disabled={fixed || x.scanning} onclick={() => radio.tune(i, "step", 1)}>▲</button>
            <button title={x.on_channel ? "Previous zone (◀)" : "Previous band (◀)"} aria-label={x.on_channel ? "Previous zone" : "Previous band"} disabled={fixed || x.scanning} onclick={() => radio.tune(i, "group", -1)}>◀</button>
            <button title={x.on_channel ? "Next zone (▶)" : "Next band (▶)"} aria-label={x.on_channel ? "Next zone" : "Next band"} disabled={fixed || x.scanning} onclick={() => radio.tune(i, "group", 1)}>▶</button>
            <button class="scan" disabled={fixed} onclick={() => radio.tune(i, "scan", x.scanning ? 0 : 1)}>{x.scanning ? "Stop scan" : "Scan"}</button>
            <form onsubmit={(e) => goChannel(i, x, e)}>
              <input
                type="number"
                min="1"
                max="4000"
                placeholder="Ch"
                aria-label={`Channel number for slot ${x.slot}`}
                disabled={fixed || x.scanning}
                bind:value={chanText[x.slot]}
              />
            </form>
          </div>
        </div>
      {/each}
    {:else if cards.length}
      {#each cards as c (c.slot)}
        {@const st = status(c)}
        <div class="slot" class:active={n(c.active) === 1} data-slot={s(c.slot)}>
          <span class="badge" style:background={slotColour[s(c.slot)] ?? "var(--blue)"}>{s(c.slot)}</span>
          <span class="what">
            <span class="main">{main(c)}</span>
            <span class="sub">{detail(c)}</span>
          </span>
          <span class="st {st.tone}">{st.text}</span>
        </div>
      {/each}
      {#if !onHome}<p class="note">As last seen on the home screen.</p>{/if}
    {:else}
      <p class="note">{connected ? "Shown from the home screen." : "Not connected."}</p>
    {/if}
  </section>

  <section>
    <h4>
      Heard now
      {#if connected}
        <button class="beacon" title="Send a position beacon now (as the radio's Beacon now)" onclick={() => radio.beaconNow()}>Beacon now</button>
      {/if}
    </h4>
    {#if heard.length}
      <div class="heard">
        {#each heard as h (h.who)}
          <span class="who">{h.who}</span><span class="dimmed">{h.what}</span><span class="dimmed t">{h.when}</span>
        {/each}
      </div>
    {:else}
      <p class="note">{connected ? "Nothing heard yet." : "Not connected."}</p>
    {/if}
  </section>

  <section>
    <h4>Radio</h4>
    {#if connected && radio.info}
      <dl>
        {#if bar}
          <dt>Battery</dt>
          <dd class:warn={n(bar.low) === 1}>{n(bar.battery)}%{n(bar.low) === 1 ? " · low" : ""}</dd>
          <dt>GPS</dt>
          <dd class={gps.tone}>{gps.text}</dd>
          <dt>Bluetooth</dt>
          <dd>{bt}</dd>
        {/if}
        <dt>Firmware</dt>
        <dd>{[radio.info.firmware, build?.name].filter(Boolean).join(" · ")}</dd>
        {#if radio.info.callsign}<dt>Callsign</dt><dd>{radio.info.callsign}</dd>{/if}
      </dl>
    {:else}
      <p class="note">Not connected.</p>
    {/if}
  </section>

  <section>
    <h4>Listen</h4>
    <p class="note" class:on={listen.on}>{listenText}</p>
  </section>
</aside>

<style>
  .panel {
    flex: 1 1 340px;
    min-width: 300px;
    max-width: 440px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    font-size: 13px;
    line-height: 1.4;
  }
  h4 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--sub);
  }
  .slot {
    display: grid;
    grid-template-columns: 22px 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid var(--line);
  }
  .slot:last-of-type {
    border-bottom: 0;
  }
  button.badge {
    border: 0;
    padding: 0;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  button.badge:disabled {
    cursor: default;
  }
  h4 .beacon {
    float: right;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 11px;
    letter-spacing: 0;
    text-transform: none;
    cursor: pointer;
  }
  h4 .beacon:hover {
    border-color: var(--blue);
  }
  .tune {
    grid-column: 2 / 4;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .tune button {
    min-width: 28px;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .tune button:hover:not(:disabled) {
    border-color: var(--blue);
  }
  .tune button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tune input {
    width: 60px;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }
  .badge {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    font-weight: 700;
    color: var(--blue-fg);
  }
  .slot:not(.active) .badge {
    opacity: 0.75;
  }
  .what {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .main {
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st {
    color: var(--sub);
    font-size: 12px;
    white-space: nowrap;
  }
  .st.rx,
  .ok {
    color: var(--green);
    font-weight: 600;
  }
  .st.tx {
    color: var(--red);
    font-weight: 600;
  }
  .st.busy {
    color: var(--blue);
  }
  .warn {
    color: var(--amber);
  }
  .heard {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 4px 12px;
    align-items: baseline;
  }
  .who {
    font-weight: 500;
    white-space: nowrap;
  }
  .dimmed {
    color: var(--sub);
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .t {
    text-align: right;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 14px;
    margin: 0;
  }
  dt {
    color: var(--sub);
  }
  dd {
    margin: 0;
  }
  .note {
    margin: 0;
    color: var(--sub);
    font-size: 12px;
  }
  .note.on {
    color: var(--blue);
  }
</style>
