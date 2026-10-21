<script lang="ts">
  // Live View (UV Studio's "Live Viewer"): the radio's screen beside its keys. The screen comes from the UI
  // readback while connected (cable: several a second; Bluetooth: about one a second; the pixel mirror, LINK-18,
  // is shelved: decision 212). Keys from the drawn keypad or the keyboard; never PTT. Display options sit in a slim
  // toolbar above the radio; the radio's details and the keyboard help open as pop-overs (Alex, Oct 20).
  import RadioFace from "../components/RadioFace.svelte";
  import ReadbackScreen from "../components/ReadbackScreen.svelte";
  import RadioInfo from "../components/RadioInfo.svelte";
  import KeyboardHelp from "../components/KeyboardHelp.svelte";
  import { radio } from "../radio.svelte";
  import { presser, turn } from "../press.svelte";
  import { sequencer } from "../sequence.svelte";
  import { copyPng, download, pngName, screenPng } from "../snapshot";

  let scale = $state(load("scale", 1.5));
  let showKeypad = $state(true);

  function load(k: string, d: number) {
    try {
      const v = Number(localStorage.getItem(k));
      return v > 0 ? v : d;
    } catch {
      return d;
    }
  }
  $effect(() => {
    try {
      localStorage.setItem("scale", String(scale));
    } catch {
      /* not kept */
    }
  });

  const connected = $derived(radio.phase === "connected");
  // Narrow windows (a phone): the radio shrinks to fit, the side keys and bezel (~150 px) included.
  let innerWidth = $state(1200);
  const fit = $derived(Math.max(0.8, Math.min(scale, (innerWidth - 32 - (showKeypad ? 150 : 16)) / 240)));

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
  function onkeydown(e: KeyboardEvent) {
    if (!connected || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
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
</script>

<svelte:window {onkeydown} {onkeyup} {onblur} bind:innerWidth />

<div class="live">
  <div class="toolbar" role="toolbar" aria-label="Display">
    <label
      >Size
      <select bind:value={scale}>
        <option value={1}>1×</option>
        <option value={1.5}>1.5×</option>
        <option value={2}>2×</option>
      </select>
    </label>
    <label><input type="checkbox" bind:checked={showKeypad} /> Keypad</label>
    <label title="Pause reading the screen (keys still work)"><input type="checkbox" bind:checked={radio.live} /> Live</label>
    {#if connected}
      <span class="meta">{radio.uiMs} ms{#if radio.ui?.screen} · {radio.ui.screen.id}{/if}</span>
    {/if}
    <span class="spacer"></span>
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
    {#if shotNote}<span class="meta" aria-live="polite">{shotNote}</span>{/if}
    {#if connected}
      <button class="btn quiet" popovertarget="radio-info" title="The radio's details">Radio</button>
    {/if}
    <button class="btn quiet" popovertarget="keys-help" title="Keyboard shortcuts" aria-label="Keyboard shortcuts">?</button>
    <form class="seq" onsubmit={sendSeq} aria-label="Key sequence">
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
      {#if sequencer.error}<span class="err" role="alert">{sequencer.error}</span>{/if}
    </form>
  </div>

  <section class="radio" aria-label="The radio">
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
            <span>Cable or Bluetooth, above. No radio? Try the demo radio.</span>
          {/if}
        </div>
      {/if}
    {/snippet}
    {#if showKeypad}
      <RadioFace {screen} scale={fit} disabled={!connected} />
    {:else}
      <div class="bare" style:width={`${240 * fit}px`} style:height={`${320 * fit}px`}>
        <div style:transform={`scale(${fit})`} style:transform-origin="0 0">{@render screen()}</div>
      </div>
    {/if}
  </section>

  <div id="radio-info" popover class="pop"><RadioInfo /></div>
  <div id="shot-menu" popover class="pop menu">
    <button class="btn quiet" popovertarget="shot-menu" popovertargetaction="hide" onclick={() => savePng(2)}>Save PNG 2× (480×640)</button>
    <button class="btn quiet" popovertarget="shot-menu" popovertargetaction="hide" onclick={copyShot}>Copy to clipboard</button>
  </div>
  <div id="keys-help" popover class="pop"><KeyboardHelp /></div>
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
  .bare {
    border-radius: 8px;
    overflow: hidden;
    border: 8px solid var(--bezel);
    box-sizing: content-box;
  }
  select {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 6px;
  }
  .meta {
    color: var(--sub);
    font-size: 12px;
  }
</style>
