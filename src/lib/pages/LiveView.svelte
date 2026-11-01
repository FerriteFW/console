<script lang="ts">
  // Live View (UV Studio's "Live Viewer"): the radio's screen beside its keys. The screen comes from the UI
  // readback while connected (cable: several a second; Bluetooth: about one a second; the pixel mirror, LINK-18,
  // is shelved: decision 212). Keys from the drawn keypad or the keyboard; never PTT. Display options sit in a slim
  // toolbar above the radio; the radio's details and the keyboard help open as pop-overs (Alex, Oct 20). Tune from
  // map opens Near me's map (the channel library's dialog): a frequency clicked tunes the active slot (Alex, Oct 31).
  import RadioFace from "../components/RadioFace.svelte";
  import ReadbackScreen from "../components/ReadbackScreen.svelte";
  import RadioInfo from "../components/RadioInfo.svelte";
  import KeyboardHelp from "../components/KeyboardHelp.svelte";
  import LivePanel from "../components/LivePanel.svelte";
  import { radio } from "../radio.svelte";
  import { listen } from "../listen.svelte";
  import { presser, turn } from "../press.svelte";
  // The wheel over the screen alone (no keypad drawn) turns the knob too, as over the drawn radio.
  let wheelAcc = 0;
  function wheel(e: WheelEvent) {
    if (!connected) return;
    e.preventDefault();
    wheelAcc += e.deltaMode === 0 ? e.deltaY / 60 : e.deltaY;
    const steps = Math.trunc(wheelAcc);
    if (steps) {
      wheelAcc -= steps;
      turn(-steps); // wheel up = clockwise
    }
  }
  import { sequencer } from "../sequence.svelte";
  import { copyPng, download, pngName, screenPng } from "../snapshot";
  import LibraryDialog from "../components/library/LibraryDialog.svelte";
  import { library } from "../library.svelte";

  let showKeypad = $state(true);
  // Tune from map's confirmation ("Tuned Slot A: 146.94 FM ..."), shown a few seconds.
  $effect(() => {
    if (!library.tuned) return;
    const t = setTimeout(() => (library.tuned = ""), 5000);
    return () => clearTimeout(t);
  });
  const connected = $derived(radio.phase === "connected");
  const asleep = $derived(connected && Number(radio.ui?.state?.dark) === 1);
  // LINK-13.4, decision 290: what Listen hears: a slot, the broadcast ("Broadcast · 101.1 · ROCK 101"), or HF mode.
  const hearing = $derived.by(() => {
    if (listen.kind === "hf") return "Hearing HF";
    if (!listen.slot) return "Nothing heard";
    if (listen.kind !== "bcast") return `Hearing ${listen.slot}`;
    const card = radio.ui?.cards.find((c) => c.slot === listen.slot);
    const mhz = card ? String(card.freq ?? "").replace(/0+$/, "").replace(/\.$/, "") : "";
    const name = String(radio.ui?.bcast?.[listen.slot]?.rds ?? "").trim().slice(0, 24);
    return ["Broadcast", mhz, name].filter(Boolean).join(" · ");
  });
  // The scale picks itself (Alex, Oct 30: "dont let the user pick"): the largest of 2x, 1.5x and 1x that fits the room
  // left under the toolbar, both ways; a smaller window (a phone) shrinks it below 1x. Drawn at 1.5x the radio is
  // about 490 x 920 px with the keypad, the screen alone 256 x 336.
  let innerWidth = $state(1200);
  let innerHeight = $state(900);
  let area: HTMLElement | undefined = $state();
  let room = $state({ w: 800, h: 700 });
  $effect(() => {
    void innerWidth;
    void innerHeight;
    void showKeypad;
    if (!area) return;
    const r = area.getBoundingClientRect();
    // From the radio's left edge to the window's right (its own box only wraps the radio, so it never grows).
    room = { w: Math.max(200, innerWidth - r.left - 24), h: Math.max(200, innerHeight - r.top - 16) };
  });
  function fitIn(roomW: number, roomH: number) {
    const [w, h] = showKeypad ? [490, 920] : [256, 336];
    const most = Math.min((1.5 * roomW) / w, (1.5 * roomH) / h);
    return [2, 1.5, 1].find((k) => k <= most) ?? Math.max(0.5, most);
  }
  // The side panel (LivePanel): on a window from WIDE px, when the radio still fits beside it at the scale it would
  // have alone (or at least 1x); else hidden. The Panel switch hides it too (remembered on this computer).
  const WIDE = 1200;
  const PANEL_MIN = 300;
  const PANEL_GAP = 20;
  const PANEL_KEY = "ferrite.livePanel";
  let panelOn = $state(readPanel());
  function readPanel() {
    try {
      return localStorage.getItem(PANEL_KEY) !== "0";
    } catch {
      return true;
    }
  }
  $effect(() => {
    const v = panelOn ? "1" : "0";
    try {
      localStorage.setItem(PANEL_KEY, v);
    } catch {
      /* private window: not remembered */
    }
  });
  const alone = $derived(fitIn(room.w, room.h));
  const beside = $derived(fitIn(room.w - PANEL_MIN - PANEL_GAP, room.h));
  const roomy = $derived(innerWidth >= WIDE && beside >= Math.min(1, alone));
  const panelShown = $derived(panelOn && roomy);
  const fit = $derived(panelShown ? beside : alone);
  let seqOpen = $state(false);
  const DEV = import.meta.env.VITE_DEV_TOOLS === "1" || import.meta.env.DEV;

  // Keyboard: as the web simulator's map (ferrite/sim-web), plus M for MENU; Shift for a long press.
  const CODES: Record<string, string> = {
    Enter: "MENU", NumpadEnter: "MENU", KeyM: "MENU",
    Escape: "BACK", Backspace: "BACK",
    ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT",
    KeyS: "SLOT", KeyV: "VM", KeyQ: "SIDE1", KeyW: "SIDE2",
    Comma: "STAR", NumpadMultiply: "STAR", Period: "HASH", NumpadDecimal: "HASH",
  };
  function keyName(e: KeyboardEvent): string | null {
    const d = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
    if (d) return d[1];
    return CODES[e.code] ?? null;
  }
  function typing(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  }
  /** A dialog or pop-over is up (Tune from map, Write, the keyboard help...): its keys are its own, Esc closes it. */
  function covered(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('[role="dialog"], [popover]')) return true;
    try {
      return !!document.querySelector('[aria-modal="true"], [popover]:popover-open');
    } catch {
      return !!document.querySelector('[aria-modal="true"]');
    }
  }
  function onkeydown(e: KeyboardEvent) {
    if (typing(e) || covered(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "?") {
      e.preventDefault();
      document.getElementById("keys-help")?.showPopover?.();
      return;
    }
    if (!connected) return;
    if (e.code === "BracketLeft" || e.code === "BracketRight") {
      e.preventDefault();
      turn(e.code === "BracketLeft" ? -1 : 1);
      return;
    }
    const name = keyName(e);
    if (!name) return;
    e.preventDefault();
    if (!e.repeat) presser.down(name, e.shiftKey);
  }
  function onkeyup(e: KeyboardEvent) {
    if (typing(e)) return;
    const name = keyName(e);
    if (name) presser.up(name);
  }
  // Save the screen as a PNG at the radio's 240 x 320 (or 2x), or copy it.
  let shotNote = $state("");
  const screenEl = () => document.querySelector<HTMLElement>("[data-readback-screen]");
  async function savePng(scale = 1) {
    const el = screenEl();
    if (!el) return;
    shotNote = "";
    try {
      download(await screenPng(el, scale), pngName(radio.ui?.screen?.id));
    } catch (e) {
      shotNote = `PNG: ${(e as Error).message}`;
    }
  }
  async function copyShot() {
    const el = screenEl();
    if (!el) return;
    try {
      await copyPng(() => screenPng(el, 1));
      shotNote = "Copied";
    } catch (e) {
      shotNote = `Copy: ${(e as Error).message}`;
    }
    setTimeout(() => (shotNote = ""), 3000);
  }

  // A typed key sequence, pressed in order; a disconnect ends it.
  let seqText = $state("");
  async function sendSeq(e: SubmitEvent) {
    e.preventDefault();
    if (sequencer.running) return;
    await sequencer.run(seqText);
  }

  function onblur() {
    for (const k of Object.keys(presser.shown)) presser.cancel(k);
  }
  // LINK-13.5: listening ends with the connection (and is never on by itself at the next one).
  $effect(() => {
    if (!radio.connectedLink && listen.on) void listen.stop();
  });
  $effect(() => {
    void listen.volume;
    void listen.muted;
    listen.apply();
  });
  const listenTitle = $derived(
    !connected ? "Connect to listen" : radio.kind !== "cable" ? "Receive audio needs the cable: Bluetooth is too slow for it" : !listen.available ? "This firmware doesn't send receive audio" : listen.on ? "Stop listening" : "Hear what the radio receives, on this computer (12 kHz: a slot while its squelch is open, else the broadcast or HF)",
  );
</script>

<svelte:window {onkeydown} {onkeyup} {onblur} bind:innerWidth bind:innerHeight />

<div class="live">
  <div class="toolbar" role="toolbar" aria-label="Display">
    <span class="listen">
      <button class="btn quiet" class:on={listen.on} aria-pressed={listen.on} disabled={!listen.available || listen.starting} title={listenTitle} onclick={() => (listen.on ? listen.stop() : listen.start())}>{listen.on ? "Listening" : "Listen"}</button>
      {#if listen.on}
        <input type="range" min="0" max="1" step="0.05" bind:value={listen.volume} aria-label="Volume" title="Volume" />
        <label title="Mute this computer (the radio keeps sending)"><input type="checkbox" bind:checked={listen.muted} /> Mute</label>
        <span class="meta">{hearing}</span>
      {/if}
      {#if listen.error}<span class="meta err">{listen.error}</span>{/if}
    </span>
    <button class="btn quiet" disabled={!connected} onclick={() => library.showTune()} title={connected ? "Pick a repeater, a licensed site or an airport near you on the map: the radio tunes to it" : "Connect to a radio to tune it from the map"}>Tune from map</button>
    {#if library.tuned}<span class="meta ok" aria-live="polite">{library.tuned}</span>{/if}
    <label><input type="checkbox" bind:checked={showKeypad} /> Keypad</label>
    {#if roomy}<label title="Slots, stations heard and the radio's state beside the radio"><input type="checkbox" bind:checked={panelOn} /> Panel</label>{/if}
    <span class="spacer"></span>
    {#if shotNote}<span class="meta" aria-live="polite">{shotNote}</span>{/if}
    <span class="group">
      <button class="btn quiet" onclick={() => savePng(1)} disabled={!connected || !radio.ui} title="Save the screen as a 240×320 PNG"
        >Save PNG</button
      ><button
        class="btn quiet more"
        popovertarget="shot-menu"
        disabled={!connected || !radio.ui}
        title="More: 2× PNG, copy"
        aria-label="More screenshot options">▾</button
      >
    </span>
    {#if connected}
      <button class="btn quiet" popovertarget="radio-info" title="The radio's details">Radio</button>
    {/if}
    <button class="btn quiet" popovertarget="keys-help" title="Keyboard: the PC's keys press the radio's (?)" aria-label="Keyboard shortcuts">?</button>
    <button class="btn quiet" popovertarget="live-more" title="More" aria-label="More Live View options">⋯</button>
  </div>
  {#if seqOpen}
    <form class="seq" onsubmit={sendSeq} aria-label="Key sequence">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        bind:value={seqText}
        oninput={() => (sequencer.error = "")}
        list="seq-recent"
        placeholder="Keys: MENU 0 7 1 · MENU:long DOWN"
        aria-label="Key sequence"
        autocomplete="off"
        spellcheck="false"
        disabled={!connected}
        autofocus
      />
      <datalist id="seq-recent">
        {#each sequencer.recent as r (r)}<option value={r}></option>{/each}
      </datalist>
      {#if sequencer.running}
        <button type="button" class="btn quiet" onclick={() => sequencer.stop()}>Stop</button>
        <span class="meta">{sequencer.at + 1}/{sequencer.total}</span>
      {:else}
        <button type="submit" class="btn quiet" disabled={!connected || !seqText.trim()}>Send</button>
      {/if}
      <button type="button" class="btn quiet" onclick={() => (seqOpen = false)} aria-label="Close the key sequence">✕</button>
      {#if sequencer.error}<span class="err" role="alert">{sequencer.error}</span>{/if}
    </form>
  {/if}

  <div class="stage">
    <section class="radio" aria-label="The radio" bind:this={area}>
      {#snippet screen()}
        {#if radio.ui && connected}
          <ReadbackScreen ui={radio.ui} />
        {:else}
          <div class="idle">
            {#if radio.phase === "connecting"}
              <b>Connecting…</b>
            {:else if radio.phase === "pin"}
              <b>PIN</b><span>Type the radio's PIN above.</span>
            {:else if connected}
              <b>Reading the screen…</b>
            {:else}
              <b>Ready to connect</b>
              <span>Cable or Bluetooth, at the top.{#if DEV} No radio? Try the demo radio.{/if}</span>
            {/if}
          </div>
        {/if}
      {/snippet}
      {#if showKeypad}
        <!-- The whole radio scales as one (keys and knob with the screen), drawn at 1.5x and zoomed to fit. -->
        <div style:zoom={fit / 1.5}><RadioFace {screen} scale={1.5} disabled={!connected} {asleep} /></div>
      {:else}
        <div class="bare" onwheel={wheel} title={asleep ? "The radio's screen is dark" : undefined} class:asleep style:width={`${240 * fit}px`} style:height={`${320 * fit}px`}>
          <div style:transform={`scale(${fit})`} style:transform-origin="0 0">{@render screen()}</div>
        </div>
      {/if}
    </section>
    {#if panelShown}<LivePanel {hearing} />{/if}
  </div>

  <LibraryDialog />
  <div id="radio-info" popover class="pop"><RadioInfo /></div>
  <div id="shot-menu" popover class="pop menu">
    <button class="btn quiet" popovertarget="shot-menu" popovertargetaction="hide" onclick={() => savePng(2)}>Save PNG 2× (480×640)</button>
    <button class="btn quiet" popovertarget="shot-menu" popovertargetaction="hide" onclick={copyShot}>Copy to clipboard</button>
  </div>
  <div id="keys-help" popover class="pop"><KeyboardHelp /></div>
  <div id="live-more" popover class="pop menu">
    <button class="btn quiet" popovertarget="live-more" popovertargetaction="hide" onclick={() => (seqOpen = true)} disabled={!connected}>Send a key sequence…</button>
    <label class="opt" title="Pause reading the screen (keys still work)"><input type="checkbox" bind:checked={radio.live} /> Update the screen live</label>
    {#if connected}
      <span class="meta" title={radio.liveByEvents ? `Live View from the radio's updates (LINK-47): ${radio.liveUpdates} so far, ${radio.liveResyncs} whole-state asks` : "Each readback's time"}>{radio.liveByEvents ? `${radio.liveRate} B/s` : `${radio.uiMs} ms`}{radio.ui?.screen ? ` · ${radio.ui.screen.id}` : ""}</span>
    {/if}
  </div>
</div>

<style>
  .live {
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: flex-start;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: center;
    width: 100%;
    max-width: 760px;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    font-size: 13px;
  }
  .toolbar label {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }
  .spacer {
    flex: 1;
  }
  .listen {
    display: inline-flex;
    gap: 8px;
    align-items: center;
  }
  .listen .on {
    color: var(--blue);
    border-color: var(--blue);
  }
  .listen input[type="range"] {
    width: 90px;
  }
  .err {
    color: var(--red);
  }
  .group {
    display: inline-flex;
  }
  .group .btn:first-child {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .group .more {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: 0;
    padding-inline: 6px;
  }
  .menu:popover-open {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
  }
  .seq {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    flex: 1 1 100%;
  }
  .seq input {
    flex: 1 1 200px;
    min-width: 0;
    font: 12px/1.2 "JetBrains Mono", monospace;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 8px;
  }
  .err {
    color: var(--red);
    font-size: 12px;
  }
  .pop {
    margin: auto;
    max-width: min(480px, calc(100vw - 32px));
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--bg);
    color: var(--text);
  }
  .pop::backdrop {
    background: rgba(0, 0, 0, 0.4);
  }
  .stage {
    display: flex;
    gap: 20px; /* PANEL_GAP */
    align-items: flex-start;
    width: 100%;
  }
  .radio {
    flex: none;
    max-width: 100%;
    overflow-x: auto;
  }
  .idle {
    width: 240px;
    height: 320px;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    text-align: center;
    padding: 20px;
    font-size: 12px;
    color: var(--sub);
  }
  .idle b {
    color: var(--text);
    font-size: 14px;
  }
  .bare.asleep {
    border-color: #2a2f36;
  }
  .bare {
    border-radius: 8px;
    overflow: hidden;
    border: 8px solid var(--bezel);
    box-sizing: content-box;
  }
  .meta {
    color: var(--sub);
    font-size: 12px;
  }
  .meta.ok {
    color: var(--green);
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-size: 13px;
  }
</style>
