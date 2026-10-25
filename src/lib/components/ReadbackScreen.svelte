<script lang="ts">
  // The radio's 240 x 320 portrait screen, drawn from the UI readback (LINK-19): a close look-alike of ferrite's
  // screens (home's cards, lists, help, toasts, the hint bar), not pixel-identical. The pixel mirror (SCREEN) gets
  // its own source (PixelScreen.svelte); this one stays as the fallback and for Bluetooth.
  import type { Kv, ScreenItem, Ui, UiLine } from "../core";

  let { ui }: { ui: Ui } = $props();

  const W = 240;
  const H = 320;
  const BAR = 20;
  const HINTS = 22;
  const ROW = 22;

  const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
  const slotColour: Record<string, string> = { A: "var(--blue)", B: "var(--amber)", C: "var(--violet)" };

  const bar = $derived(ui.bar);
  const title = $derived(ui.screen?.title || (ui.screen?.id === "Home" ? s(bar.call) : ui.screen?.name) || "");
  const clock = $derived(s(bar.clock) === "-" || !bar.clock ? s(bar.call) : s(bar.clock) + (n(bar.utc) === 1 ? "Z" : ""));
  const battery = $derived(n(bar.battery));
  const dark = $derived(n(ui.state.dark) === 1);
  const cards = $derived(ui.cards);
  const hasCards = $derived(cards.length > 0);

  /** "146.52000" -> ["146.520", "00"]: the last two digits drawn small, as home draws them. */
  function freqParts(f: string): [string, string] {
    const m = /^(\d+\.\d{3})(\d{2})$/.exec(f);
    return m ? [m[1], m[2]] : [f, ""];
  }

  /** The rows that fit, scrolled so the selected one shows. */
  const rowsShown = $derived.by(() => {
    const room = H - BAR - HINTS - (ui.help ? 80 : 0) - otherLines.length * 16 - 4;
    const fit = Math.max(1, Math.floor(room / ROW));
    const sel = ui.sel ?? 0;
    const start = Math.max(0, Math.min(sel - fit + 1, ui.rows.length - fit));
    return ui.rows.slice(Math.max(0, start), Math.max(0, start) + fit);
  });

  // Lines that describe the radio, not something on its screen: `state`, and `audio` (LINK-13: the stream's counters).
  // Frequency entry (LINK-19.4): the digits, the slot and what they are for; its rows and help come as rows and help.
  const entry = $derived(ui.other.find((l) => l.kind === "entry") ?? null);
  const entryParts = $derived.by(() => {
    const t = entry?.args[0] ?? "";
    const p = t.indexOf(".");
    return p >= 0 && t.length > p + 4 ? [t.slice(0, p + 4), t.slice(p + 4)] : [t, ""];
  });
  const entryBig = $derived(entryParts[0]);
  const entrySmall = $derived(entryParts[1]);
  const otherLines = $derived(ui.other.filter((l) => l.kind !== "state" && l.kind !== "audio" && l.kind !== "entry"));

  // LINK-19.5: a screen sent as drawn (its texts and fills, absolute coordinates) is placed as the radio drew it.
  const items = $derived(ui.items ?? []);
  /** The radio's fonts by id (uistate.rs `font_id`): size in px, weight, family. */
  const FONTS: [number, number, string][] = [
    [12, 500, "mono"], [12, 700, "mono"], [15, 700, "mono"], [22, 700, "mono"], [26, 700, "mono"],
    [17, 700, "digits"], [26, 700, "digits"], [28, 700, "digits"], [46, 700, "digits"], [40, 600, "brand"],
  ];
  const family = (f: string) =>
    f === "digits" ? '"Ferrite Mono Tight", "JetBrains Mono", monospace' : f === "brand" ? '"Barlow", sans-serif' : '"JetBrains Mono", monospace';
  const css565 = (c: number) => `rgb(${((c >> 11) & 31) * 255 / 31 | 0},${((c >> 5) & 63) * 255 / 63 | 0},${(c & 31) * 255 / 31 | 0})`;
  function itemStyle(it: ScreenItem): string {
    const box = `left:${it.x}px;top:${it.y - BAR}px;width:${it.w}px;height:${it.h}px;`;
    if (it.k === "r") return box + `background:${css565(it.c)};`;
    if (it.k === "o") return box + `background:${css565(it.c)};border-radius:50%;transform:scale(0.6);`;
    const [size, weight, fam] = FONTS[it.font] ?? FONTS[0];
    const bg = it.bg === null ? "" : `background:${css565(it.bg)};`;
    return box + bg + `color:${css565(it.fg)};font:${weight} ${size}px/${it.h}px ${family(fam)};`;
  }

  /** A text squeezed to the width the radio measured, when Console's font runs wider (never stretched). */
  function fit(el: HTMLElement, w: number) {
    const go = (w: number) => {
      el.style.transform = "";
      const natural = el.scrollWidth;
      el.style.transformOrigin = "left center";
      el.style.transform = natural > w + 1 ? `scaleX(${w / natural})` : "";
    };
    go(w);
    return { update: go };
  }

  function lineText(l: UiLine) {
    const kv = Object.entries(l.kv)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    return [l.kind, ...l.args.map((a) => (a.includes(" ") ? `“${a}”` : a)), kv].filter(Boolean).join(" ");
  }

  const isActive = (c: Kv) => n(c.active) === 1;

  // APRS-17: the APRS card as home draws it (ferrite screens/home.rs `aprs_card`). The right fact: APRS mode's
  // counts (APRS-17.2: both on the large card, in turn every 5 s on the small one), KISS's port, the beacon's
  // countdown; the bottom line: the last station, KISS's counts, the beacon's interval; the power at its right.
  let turn = $state(false);
  $effect(() => {
    const t = setInterval(() => (turn = !turn), 5000);
    return () => clearInterval(t);
  });
  function aprsRight(c: Kv, both: boolean) {
    if (c.holder === "kiss") return s(c.port);
    if (c.holder === "beacon") return s(c.next);
    const heard = `${n(c.heard)} heard`;
    if (c.hour === undefined) return heard; // a radio from before the hourly count
    const hour = `${n(c.hour)} /hr`;
    if (!both && c.turn !== undefined) return n(c.turn) ? hour : heard; // the one the radio's small card shows now
    return both ? `${heard} · ${hour}` : turn ? hour : heard;
  }
  function aprsLine(c: Kv) {
    if (c.holder === "kiss") return `Sent ${n(c.sent)} · Heard ${n(c.frames)}`;
    if (c.holder === "beacon") return s(c.line);
    if (c.turn !== undefined) return s(c.last) || "Nothing heard yet"; // as drawn: the last heard since power-on
    return s(c.last) ? `Last ${s(c.last)}` : "Nothing heard yet";
  }
  const aprsPower = (c: Kv) => (c.state === "Muted" ? `Muted · ${s(c.power)}` : s(c.power));
  /** A card's header: who wins C's VHF chip when a watched slot shares it (APRS-17, WATCH-17.3): 1 APRS first,
   *  2 Voice first. */
  const headText = (c: Kv) => s(c.head) + (n(c.shared) === 1 ? "  VHF: APRS" : n(c.shared) === 2 ? "  VHF: voice" : "");
  /** The state word, or the tone hint in its place ("Heard 88.5", TSRCH-13). */
  const stateText = (c: Kv) => s(c.hint) || s(c.state);
  const stateColour = (st: string) =>
    st === "TX" ? "var(--red)" : st.startsWith("RX") || st === "MON" ? "var(--green)" : st === "heard" ? "var(--amber)" : "var(--sub)";
</script>

<div class="screen" data-readback-screen style:width={`${W}px`} style:height={`${H}px`} aria-label="The radio's screen, from the UI readback">
  <!-- status bar -->
  <div class="sbar" style:height={`${BAR}px`}>
    <span class="title">{title}</span>
    <span class="clock">{clock}</span>
    <span class="icons">
      {#if n(bar.dry)}<span class="tagdry" title="Dry TX on: the PA held at 0">DRY</span>{/if}
      {#if n(bar.lock)}<span title="Keys locked">🔒︎</span>{/if}
      {#if n(bar.scan)}<span class="tag" title="Scanning">SCN</span>{/if}
      {#if n(bar.watch) >= 2}<span class="tag" title="Watch">{n(bar.watch) >= 3 ? "TW" : "DW"}</span>{/if}
      {#if n(bar.inbox)}<span title="Messages">✉{n(bar.inbox) > 1 ? n(bar.inbox) : ""}</span>{/if}
      {#if bar.gps && bar.gps !== "off"}<span class:dim={bar.gps !== "fix"} title="GPS {bar.gps}">⌖</span>{/if}
      {#if n(bar.bt_on)}<span class="bt" class:on={n(bar.bt) === 1} title={n(bar.bt) ? "Bluetooth connected" : "Bluetooth on"}>ᛒ</span>{/if}
      <span class="batt" class:low={n(bar.low) === 1} title={`Battery ${battery}%`}>
        <span class="fill" style:width={`${Math.max(0, Math.min(100, battery))}%`}></span>
      </span>
    </span>
  </div>

  <div class="body" style:height={`${H - BAR - HINTS}px`}>
    {#if items.length}
      <div class="items">
        {#each items as it, i (i)}
          {#if it.k === "t"}<span class="it tx" style={itemStyle(it)} use:fit={it.w}>{it.s}</span>{:else}<span class="it" style={itemStyle(it)}></span>{/if}
        {/each}
      </div>
    {:else if hasCards}
      <div class="cards">
        {#each cards as c (c.slot)}
          {@const slot = s(c.slot)}
          {@const st = s(c.state)}
          {@const [big, small] = freqParts(s(c.freq))}
          {#if isActive(c)}
            <div class="card active">
              <div class="head">
                <span class="badge on" style:background={slotColour[slot]}>{slot}</span>
                <span class="htext">{headText(c)}</span>
                {#if st && st !== "idle"}<span class="state" style:color={stateColour(st)}>{stateText(c)}</span>{/if}
              </div>
              {#if c.kind === "aprs"}
                <div class="freq">{big}<small>{small}</small></div>
                <div class="aprsrow"><span class="l">{aprsLine(c)}</span><span class="r" class:warn={c.state === "Muted"}>{aprsPower(c)}</span></div>
                <div class="aprsrow"><span class="l">{s(c.beacon)}</span><span class="r b">{aprsRight(c, true)}</span></div>
              {:else}
                {#if s(c.name)}<div class="cname">{s(c.name)}</div>{/if}
                {#if c.kind === "broadcast"}
                  {@const b = ui.bcast[slot]}
                  <div class="freq">{Number(s(c.freq)).toFixed(1)}<small> MHz</small></div>
                  {#if b}<div class="aprsrow"><span class="l">{n(b.stereo) ? "STEREO" : ""}</span><span class="r">SNR {n(b.snr)} dB</span></div>{/if}
                  <div class="aprs sub">{b ? s(b.rds) || "No RDS" : ""}</div>
                {:else}
                  <div class="freq" class:withname={!!s(c.name)}>{big}<small>{small}</small></div>
                  <div class="chips">
                    {#each [c.mode, c.tone, c.shift, c.power] as chip, i (i)}
                      {#if s(chip)}<span class="chip">{s(chip)}</span>{/if}
                    {/each}
                  </div>
                {/if}
              {/if}
              {#if c.kind !== "aprs"}<div class="meter">
                {#each Array.from({ length: 20 }, (_, i) => i) as i (i)}
                  <span class="seg" class:lit={i < n(c.meter)} class:over={i >= 17 && i < n(c.meter)}></span>
                {/each}
                <span class="s">{s(c.s)}</span>
              </div>{/if}
            </div>
          {:else}
            <div class="card">
              <div class="head">
                <span class="badge" style:border-color={slotColour[slot]} style:color={slotColour[slot]}>{slot}</span>
                <span class="htext">{headText(c)}</span>
                <span class="state" style:color={stateColour(st)}>{stateText(c)}</span>
              </div>
              <div class="line2">
                {#if s(c.name)}
                  <span class="cname2">{s(c.name)}</span><span class="f2">{s(c.freq).replace(/0+$/, "").replace(/\.$/, ".0")}</span>
                {:else if c.kind === "aprs"}
                  <span class="freq2">{big}<small>{small}</small></span><span class="f2 b">{aprsRight(c, false)}</span>
                {:else}
                  <span class="freq2">{big}<small>{small}</small></span>
                  {#if n(c.hits)}<span class="f2">{n(c.hits)} hits</span>{:else if n(c.rx)}<span class="f2" style:color="var(--green)">{s(c.s)}</span>{/if}
                {/if}
              </div>
              {#if c.kind === "slot"}
                <div class="chips2">{[c.mode, c.tone, c.shift].map(s).filter(Boolean).join(" ")}</div>
              {:else if c.kind === "aprs"}
                <div class="aprsrow sm"><span class="l">{aprsLine(c)}</span><span class="r" class:warn={c.state === "Muted"}>{aprsPower(c)}</span></div>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {:else}
      {#if entry}
        <div class="entry">
          <div class="ehead"><span class="badge on" style:background={slotColour[s(entry.kv.slot)] ?? "var(--blue)"}>{s(entry.kv.slot)}</span><span>{s(entry.kv.what)}</span></div>
          <div class="edigits">{entryBig}<small>{entrySmall}</small><span class="ecursor"></span></div>
        </div>
      {/if}
      {#if rowsShown.length}
        <div class="rows">
          {#each rowsShown as r, i (i)}
            <div class="row" class:sel={r.sel} class:grey={r.grey} style:height={`${ROW}px`}>
              {#if r.num}<span class="num">{r.num}</span>{/if}
              <span class="rname">{r.name}</span>
              <span class="rval">{r.value}{#if r.dot}<span class="rdot">•</span>{/if}</span>
            </div>
          {/each}
        </div>
      {/if}
      {#if otherLines.length}
        <div class="other">
          {#each otherLines as l, i (i)}
            <div>{lineText(l)}</div>
          {/each}
        </div>
      {/if}
      {#if entry && s(entry.kv.note)}
        <div class="enote">{s(entry.kv.note)}</div>
      {/if}
      {#if ui.help}
        <div class="help">{ui.help.body}</div>
      {/if}
      {#if !rowsShown.length && !otherLines.length && !ui.help}
        <div class="empty">{ui.screen?.name ?? ""}</div>
      {/if}
    {/if}
  </div>

  <div class="hints" style:height={`${HINTS}px`}>
    {#each ui.hints as [k, label], i (i)}
      <span><b>{k}</b> {label}</span>
    {/each}
  </div>

  {#if ui.qmenu.length}
    <div class="qmenu">
      {#each ui.qmenu as q, i (i)}
        <div class="qrow"><b>{q[0]}</b><span>{q[1]}</span><span class="qv">{q[2]}</span></div>
      {/each}
    </div>
  {/if}
  {#if ui.popup}
    <div class="popup"><b>{ui.popup.head}</b>{#if ui.popup.body}<span>{ui.popup.body}</span>{/if}</div>
  {/if}
  {#if ui.toast}
    <div class="toast"><b>{ui.toast.head}</b>{#if ui.toast.body}<span>{ui.toast.body}</span>{/if}</div>
  {/if}
</div>

<style>
  .screen {
    position: relative;
    background: var(--bg);
    color: var(--text);
    overflow: hidden;
    font: 500 13px/1.2 "JetBrains Mono", monospace;
    user-select: none;
  }
  .sbar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0 5px;
    border-bottom: 1px solid var(--line);
    font-size: 11px;
  }
  .title {
    color: var(--sub);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .clock {
    font-weight: 700;
  }
  .icons {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    align-items: center;
  }
  .dim {
    color: var(--dim);
  }
  .bt {
    color: var(--dim);
  }
  .bt.on {
    color: var(--blue);
  }
  .tagdry {
    font-size: 8px;
    font-weight: 700;
    color: var(--amber);
    border: 1px solid var(--amber);
    border-radius: 2px;
    padding: 0 2px;
  }
  .batt {
    position: relative;
    width: 18px;
    height: 9px;
    border: 1px solid var(--text);
    border-radius: 2px;
    padding: 1px;
    display: inline-flex;
  }
  .batt::after {
    content: "";
    position: absolute;
    right: -3px;
    top: 2px;
    width: 2px;
    height: 3px;
    background: var(--text);
  }
  .batt .fill {
    background: var(--green);
    height: 100%;
  }
  .batt.low .fill {
    background: var(--red);
  }
  .body {
    position: relative;
    overflow: hidden;
  }
  .items {
    position: absolute;
    inset: 0;
  }
  .tx {
    width: auto !important;
  }
  .it {
    position: absolute;
    white-space: pre;
    overflow: visible;
    letter-spacing: 0;
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 5px;
  }
  .card {
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--surface);
    padding: 4px 6px 5px;
  }
  .card.active {
    border-color: var(--blue);
    background: var(--bg);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--sub);
    white-space: nowrap;
  }
  .htext {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    display: inline-grid;
    place-items: center;
    width: 12px;
    height: 13px;
    border: 1px solid;
    border-radius: 2px;
    font-size: 10px;
    font-weight: 700;
  }
  .badge.on {
    color: var(--blue-fg);
    border-color: transparent;
  }
  .state {
    font-size: 11px;
  }
  .cname {
    font-weight: 700;
    font-size: 15px;
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
  }
  .freq {
    font: 700 46px/1 "Ferrite Mono Tight", "JetBrains Mono", monospace;
    letter-spacing: -0.02em;
    margin: 2px 0 4px;
  }
  .freq.withname {
    font-size: 30px;
  }
  .freq small,
  .freq2 small {
    font-size: 0.5em;
    color: var(--sub);
    margin-left: 1px;
  }
  .chips {
    display: flex;
    gap: 3px;
  }
  .chip {
    flex: 1;
    text-align: center;
    border: 1px solid var(--line);
    font-size: 10px;
    padding: 1px 0;
    white-space: nowrap;
    overflow: hidden;
  }
  .meter {
    display: flex;
    align-items: center;
    gap: 1px;
    margin-top: 5px;
  }
  .seg {
    flex: 1;
    height: 6px;
    border-radius: 1px;
    background: var(--line);
  }
  .seg.lit {
    background: var(--green);
  }
  .seg.over {
    background: var(--amber);
  }
  .s {
    width: 26px;
    text-align: right;
    font-size: 10px;
    font-weight: 700;
  }
  .line2 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
    margin-top: 3px;
  }
  .cname2 {
    font-weight: 700;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .f2 {
    color: var(--sub);
    font-size: 12px;
  }
  .freq2 {
    font: 700 24px/1 "Ferrite Mono Tight", "JetBrains Mono", monospace;
  }
  .chips2,
  .aprs {
    font-size: 10px;
    color: var(--sub);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .aprs {
    color: var(--text);
    font-size: 11px;
  }
  .tag {
    font: 700 10px/1 var(--mono, monospace);
    color: var(--blue);
  }
  .entry {
    padding: 4px 8px 6px;
    border-bottom: 1px solid var(--line);
  }
  .ehead {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: var(--sub);
  }
  .edigits {
    font: 700 46px/1.1 "Ferrite Mono Tight", "JetBrains Mono", monospace;
    margin-top: 10px;
    display: flex;
    align-items: baseline;
  }
  .edigits small {
    font-size: 28px;
  }
  .ecursor {
    display: inline-block;
    width: 16px;
    height: 4px;
    background: var(--blue);
    margin-left: 3px;
  }
  .enote {
    padding: 4px 8px;
    color: var(--amber);
    font-size: 12px;
  }
  .aprsrow {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--sub);
    margin-top: 3px;
    white-space: nowrap;
  }
  .aprsrow.sm {
    font-size: 10px;
  }
  .aprsrow .l {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .aprsrow .r.warn {
    color: var(--amber);
  }
  .b {
    font-weight: 700;
    color: var(--text);
  }
  .aprs.sub {
    color: var(--sub);
  }
  .rows {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 5px;
    font-size: 12px;
    white-space: nowrap;
  }
  .row.sel {
    background: var(--blue);
    color: var(--blue-fg);
  }
  .row.grey {
    color: var(--dim);
  }
  .num {
    color: var(--sub);
    width: 10px;
  }
  .row.sel .num {
    color: inherit;
  }
  .rname {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rval {
    color: var(--sub);
    overflow: hidden;
    max-width: 50%;
    text-overflow: ellipsis;
  }
  .row.sel .rval {
    color: inherit;
  }
  .rdot {
    color: var(--blue);
    margin-left: 2px;
  }
  .row.sel .rdot {
    color: inherit;
  }
  .other {
    padding: 4px 6px;
    font-size: 10px;
    color: var(--sub);
    display: flex;
    flex-direction: column;
    gap: 2px;
    word-break: break-word;
  }
  .help {
    margin: 4px 6px;
    padding: 5px 7px;
    background: var(--surface);
    border-radius: 3px;
    font-size: 11px;
    max-height: 72px;
    overflow: hidden;
  }
  .empty {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--sub);
  }
  .hints {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 5px;
    border-top: 1px solid var(--line);
    font-size: 11px;
    color: var(--sub);
    white-space: nowrap;
    overflow: hidden;
  }
  .hints b {
    color: var(--text);
  }
  .toast,
  .popup {
    position: absolute;
    left: 10px;
    right: 10px;
    background: var(--toast);
    border: 1px solid var(--blue);
    border-radius: 4px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
  }
  .toast {
    bottom: 26px;
  }
  .popup {
    top: 50%;
    transform: translateY(-50%);
    text-align: center;
    padding: 12px 8px;
    font-size: 14px;
  }
  .toast span,
  .popup span {
    color: var(--sub);
  }
  .qmenu {
    position: absolute;
    left: 14px;
    right: 14px;
    top: 50px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 11px;
  }
  .qrow {
    display: flex;
    gap: 6px;
    padding: 2px 0;
  }
  .qrow span:first-of-type {
    flex: 1;
  }
  .qv {
    color: var(--sub);
  }
</style>
