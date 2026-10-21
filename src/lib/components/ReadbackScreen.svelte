<script lang="ts">
  // The radio's 240 x 320 portrait screen, drawn from the UI readback (LINK-19): a close look-alike of ferrite's
  // screens (home's cards, lists, help, toasts, the hint bar), not pixel-identical. The pixel mirror (SCREEN) gets
  // its own source (PixelScreen.svelte); this one stays as the fallback and for Bluetooth.
  import type { Kv, Ui, UiLine } from "../core";

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
  const clock = $derived(s(bar.clock) === "-" || !bar.clock ? s(bar.call) : s(bar.clock));
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

  const otherLines = $derived(ui.other.filter((l) => l.kind !== "state"));

  function lineText(l: UiLine) {
    const kv = Object.entries(l.kv)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    return [l.kind, ...l.args.map((a) => (a.includes(" ") ? `“${a}”` : a)), kv].filter(Boolean).join(" ");
  }

  const isActive = (c: Kv) => n(c.active) === 1;
  const stateColour = (st: string) =>
    st === "TX" ? "var(--red)" : st.startsWith("RX") || st === "MON" ? "var(--green)" : st === "heard" ? "var(--amber)" : "var(--sub)";
</script>

<div class="screen" style:width={`${W}px`} style:height={`${H}px`} aria-label="The radio's screen, from the UI readback">
  <!-- status bar -->
  <div class="sbar" style:height={`${BAR}px`}>
    <span class="title">{title}</span>
    <span class="clock">{clock}</span>
    <span class="icons">
      {#if n(bar.dry)}<span class="tagdry" title="Dry TX on: the PA held at 0">DRY</span>{/if}
      {#if n(bar.lock)}<span title="Keys locked">🔒︎</span>{/if}
      {#if n(bar.scan)}<span title="Scanning">⟳</span>{/if}
      {#if n(bar.inbox)}<span title="Messages">✉{n(bar.inbox) > 1 ? n(bar.inbox) : ""}</span>{/if}
      {#if bar.gps && bar.gps !== "off"}<span class:dim={bar.gps !== "fix"} title="GPS {bar.gps}">⌖</span>{/if}
      {#if n(bar.bt_on)}<span class="bt" class:on={n(bar.bt) === 1} title={n(bar.bt) ? "Bluetooth connected" : "Bluetooth on"}>ᛒ</span>{/if}
      <span class="batt" class:low={n(bar.low) === 1} title={`Battery ${battery}%`}>
        <span class="fill" style:width={`${Math.max(0, Math.min(100, battery))}%`}></span>
      </span>
    </span>
  </div>

  <div class="body" style:height={`${H - BAR - HINTS}px`}>
    {#if hasCards}
      <div class="cards">
        {#each cards as c (c.slot)}
          {@const slot = s(c.slot)}
          {@const st = s(c.state)}
          {@const [big, small] = freqParts(s(c.freq))}
          {#if isActive(c)}
            <div class="card active">
              <div class="head">
                <span class="badge on" style:background={slotColour[slot]}>{slot}</span>
                <span class="htext">{s(c.head)}</span>
                {#if st && st !== "idle"}<span class="state" style:color={stateColour(st)}>{st}</span>{/if}
              </div>
              {#if c.kind === "aprs"}
                <div class="aprs">{s(c.last) || "Nothing heard yet"}</div>
                <div class="aprs sub">{s(c.beacon)}</div>
              {:else}
                {#if s(c.name)}<div class="cname">{s(c.name)}</div>{/if}
                <div class="freq" class:withname={!!s(c.name)}>{big}<small>{small}</small></div>
                {#if c.kind === "broadcast"}
                  {@const b = ui.bcast[slot]}
                  <div class="aprs sub">{b ? s(b.rds) || "No RDS" : ""}</div>
                {:else}
                  <div class="chips">
                    {#each [c.mode, c.tone, c.shift, c.power] as chip, i (i)}
                      {#if s(chip)}<span class="chip">{s(chip)}</span>{/if}
                    {/each}
                  </div>
                {/if}
              {/if}
              <div class="meter">
                {#each Array.from({ length: 20 }, (_, i) => i) as i (i)}
                  <span class="seg" class:lit={i < n(c.meter)} class:over={i >= 17 && i < n(c.meter)}></span>
                {/each}
                <span class="s">{s(c.s)}</span>
              </div>
            </div>
          {:else}
            <div class="card">
              <div class="head">
                <span class="badge" style:border-color={slotColour[slot]} style:color={slotColour[slot]}>{slot}</span>
                <span class="htext">{s(c.head)}</span>
                <span class="state" style:color={stateColour(st)}>{st}</span>
              </div>
              <div class="line2">
                {#if s(c.name)}
                  <span class="cname2">{s(c.name)}</span><span class="f2">{s(c.freq).replace(/0+$/, "").replace(/\.$/, ".0")}</span>
                {:else}
                  <span class="freq2">{big}<small>{small}</small></span>
                  {#if n(c.rx)}<span class="f2" style:color="var(--green)">{s(c.s)}</span>{/if}
                {/if}
              </div>
              {#if c.kind === "slot"}
                <div class="chips2">{[c.mode, c.tone, c.shift].map(s).filter(Boolean).join(" ")}</div>
              {:else if c.kind === "aprs"}
                <div class="chips2">{s(c.last)}</div>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {:else}
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
  <!-- The radio's backlight is off: a small mark only. Console keys wake it and act at once (DISP-15.1), so the
       screen stays readable here. -->
  {#if dark}<div class="asleep" title="The radio's screen is dark. Keys from here wake it and act at once.">☾ screen off</div>{/if}
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
  .asleep {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 1px 6px;
    border-radius: 8px;
    background: rgb(0 0 0 / 0.6);
    border: 1px solid #3a4049;
    color: #aab2bd;
    font-size: 10px;
    pointer-events: none;
  }
</style>
