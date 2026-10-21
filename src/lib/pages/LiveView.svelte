<script lang="ts">
  // Live View (UV Studio's "Live Viewer"): the radio's screen beside its keys. The screen comes from the UI
  // readback while connected (cable: several a second; Bluetooth: about one a second); the pixel mirror's source
  // slots in later (PixelScreen). Keys from the drawn keypad or the keyboard; never PTT.
  import RadioFace from "../components/RadioFace.svelte";
  import ReadbackScreen from "../components/ReadbackScreen.svelte";
  import PixelScreen from "../components/PixelScreen.svelte";
  import RadioInfo from "../components/RadioInfo.svelte";
  import KeyboardHelp from "../components/KeyboardHelp.svelte";
  import { radio } from "../radio.svelte";
  import { presser, turn } from "../press.svelte";

  type Source = "readback" | "pixels";
  let source = $state<Source>("readback");
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
  function onblur() {
    for (const k of Object.keys(presser.shown)) presser.cancel(k);
  }
</script>

<svelte:window {onkeydown} {onkeyup} {onblur} bind:innerWidth />

<div class="live">
  <section class="radio" aria-label="The radio">
    {#snippet screen()}
      {#if source === "pixels"}
        <PixelScreen />
      {:else if radio.ui && connected}
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

  <aside class="panels">
    <RadioInfo />

    <div class="card">
      <div class="label">Display</div>
      <div class="opts">
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
      </div>
      <div class="opts">
        <span>Screen</span>
        <label><input type="radio" bind:group={source} value="readback" /> Readback</label>
        <label title="The cable's pixel mirror (SCREEN): coming in a later firmware">
          <input type="radio" bind:group={source} value="pixels" disabled /> Pixels <span class="soon">soon</span>
        </label>
      </div>
      {#if connected}
        <div class="meta">
          Readback {radio.uiMs} ms{#if radio.ui?.screen} · screen {radio.ui.screen.id}{/if}
        </div>
      {/if}
    </div>

    <div class="card audio" aria-label="Receive audio">
      <div class="label">Audio</div>
      <p>Receive audio over the cable (8 kHz IMA ADPCM, LINK-13.1) plays here in a later version.</p>
    </div>

    <KeyboardHelp />
  </aside>
</div>

<style>
  .live {
    display: flex;
    gap: 28px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .radio {
    flex: none;
    max-width: 100%;
    overflow-x: auto;
  }
  .panels {
    flex: 1;
    min-width: 280px;
    max-width: 460px;
    display: flex;
    flex-direction: column;
    gap: 14px;
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
  .opts {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    align-items: center;
    margin-top: 10px;
  }
  .opts label {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }
  select {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 6px;
  }
  .soon {
    font-size: 10px;
    color: var(--sub);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 4px;
  }
  .meta {
    margin-top: 10px;
    color: var(--sub);
    font-size: 12px;
  }
  .audio p {
    margin: 8px 0 0;
    color: var(--sub);
    font-size: 13px;
  }
</style>
