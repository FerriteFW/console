<script lang="ts">
  // The RT-950 Pro's front, after ferrite's simulator (sim/src/face.rs): the channel knob on top, SIDE1 and SIDE2
  // on the left edge, the screen, the function keys (OK/MENU, A·B·C, the arrows, BACK, V/M) and the 3 x 4 keypad.
  // PTT A and PTT B are drawn, greyed: remote keys never transmit.
  import type { Snippet } from "svelte";
  import { presser, turn } from "../press.svelte";

  let { screen, scale = 1.5, disabled = false }: { screen: Snippet; scale?: number; disabled?: boolean } = $props();

  type K = { name: string; label: string; small?: string; cls?: string; aria?: string };
  const digits: K[] = [
    { name: "1", label: "1", small: "!<" },
    { name: "2", label: "2", small: "ABC" },
    { name: "3", label: "3", small: "DEF" },
    { name: "4", label: "4", small: "GHI" },
    { name: "5", label: "5", small: "JKL" },
    { name: "6", label: "6", small: "MNO" },
    { name: "7", label: "7", small: "PQRS" },
    { name: "8", label: "8", small: "TUV" },
    { name: "9", label: "9", small: "WXYZ" },
    { name: "STAR", label: "*", small: "_", aria: "Star" },
    { name: "0", label: "0", small: "+" },
    { name: "HASH", label: "#", small: "^", aria: "Hash" },
  ];

  function handlers(name: string) {
    return {
      onpointerdown: (e: PointerEvent) => {
        if (disabled || e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        presser.down(name, e.shiftKey);
      },
      onpointerup: () => presser.up(name),
      onpointercancel: () => presser.cancel(name),
      onlostpointercapture: () => presser.cancel(name),
      // Keyboard activation of the focused button (Enter/Space on it): a short press.
      onkeydown: (e: KeyboardEvent) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat && !disabled) {
          e.preventDefault();
          e.stopPropagation();
          presser.down(name, e.shiftKey);
        }
      },
      onkeyup: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          presser.up(name);
        }
      },
    };
  }

  let wheelAcc = 0;
  function wheel(e: WheelEvent) {
    if (disabled) return;
    e.preventDefault();
    wheelAcc += e.deltaMode === 0 ? e.deltaY / 60 : e.deltaY;
    const steps = Math.trunc(wheelAcc);
    if (steps) {
      wheelAcc -= steps;
      turn(-steps); // wheel up = clockwise
    }
  }
  function knobClick(e: MouseEvent) {
    if (disabled) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    turn(e.clientX < r.left + r.width / 2 ? -1 : 1);
  }
</script>

{#snippet key(k: K)}
  <button
    class="key {k.cls ?? ''}"
    class:down={!!presser.shown[k.name]}
    class:long={presser.shown[k.name] === "long"}
    aria-label={k.aria ?? (k.small ? `${k.label} (${k.small})` : k.label)}
    title={`${k.aria ?? k.label}: click, or hold for a long press`}
    {disabled}
    {...handlers(k.name)}
  >
    <span class="kl">{k.label}</span>
    {#if k.small}<span class="ks">{k.small}</span>{/if}
  </button>
{/snippet}

<div class="face" style:--k={scale}>
  <div class="top">
    <div class="vol" title="Volume (not remote)"></div>
    <button
      class="knob"
      {disabled}
      onclick={knobClick}
      onwheel={wheel}
      aria-label="Channel knob: click the left half or the right half, or scroll"
      title="Channel knob: click left (−1) or right (+1), or scroll"
    >
      <span>‹</span><span class="ridges"></span><span>›</span>
    </button>
    <!-- The radio's top, left to right: volume, channel knob, the LED (a rectangle), the antenna. -->
    <div class="led" title="LED"></div>
    <div class="antenna"></div>
  </div>

  <div class="bodyrow">
    <div class="sidekeys">
      <!-- The radio's side keys top to bottom: PTT A, PTT B, PF1, PF2. The PTTs are drawn but never pressed from
           Console: remote keys never transmit (LINK-19). -->
      <div class="ptt" title="PTT A: never from Console">PTT A</div>
      <div class="ptt" title="PTT B: never from Console">PTT B</div>
      {@render key({ name: "SIDE1", label: "SIDE1", small: "PF1", cls: "side" })}
      {@render key({ name: "SIDE2", label: "SIDE2", small: "PF2", cls: "side" })}
    </div>

    <div class="body">
      <div class="bezel" onwheel={wheel}>
        <div class="scaled" style:transform={`scale(${scale})`}>
          {@render screen()}
        </div>
      </div>

      <div class="fkeys">
        <div class="col">
          {@render key({ name: "MENU", label: "OK", small: "MENU", cls: "fn" })}
          {@render key({ name: "SLOT", label: "A·B·C", small: "SLOT", cls: "fn" })}
        </div>
        <div class="dpad">
          {@render key({ name: "UP", label: "▲", cls: "up", aria: "Up" })}
          {@render key({ name: "LEFT", label: "◀", cls: "left", aria: "Left" })}
          {@render key({ name: "RIGHT", label: "▶", cls: "right", aria: "Right" })}
          {@render key({ name: "DOWN", label: "▼", cls: "down-k", aria: "Down" })}
        </div>
        <div class="col">
          {@render key({ name: "BACK", label: "BACK", cls: "fn" })}
          {@render key({ name: "VM", label: "V/M", cls: "fn", aria: "V/M" })}
        </div>
      </div>

      <div class="digits">
        {#each digits as d (d.name)}
          {@render key(d)}
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .face {
    --screen-w: calc(240px * var(--k));
    display: inline-flex;
    flex-direction: column;
    align-items: stretch;
    user-select: none;
    -webkit-user-select: none;
    touch-action: manipulation;
  }
  .top {
    display: flex;
    align-items: flex-end;
    gap: 14px;
    padding-left: calc(58px + 34px);
    height: 40px;
  }
  /* Alex, Oct 20: the volume knob about 70 % of the channel knob, the antenna three times wider than before. */
  .vol {
    width: 84px;
    height: 26px;
    border-radius: 7px 7px 0 0;
    background: repeating-linear-gradient(90deg, var(--key) 0 6px, #23272d 6px 9px);
    border: 1px solid var(--key-edge);
    border-bottom: 0;
    opacity: 0.7;
  }
  .knob {
    width: 120px;
    height: 34px;
    border-radius: 8px 8px 0 0;
    border: 1px solid var(--key-edge);
    border-bottom: 0;
    background: repeating-linear-gradient(90deg, var(--key) 0 6px, #23272d 6px 9px);
    color: var(--key-text);
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 8px;
    cursor: ew-resize;
    font-size: 18px;
  }
  .knob:hover:not(:disabled) {
    border-color: var(--blue);
  }
  .led {
    width: 30px;
    height: 10px;
    margin-left: auto;
    border-radius: 2px 2px 0 0;
    border-bottom: 0;
    background: #2a2f36;
    border: 1px solid var(--key-edge);
  }
  .antenna {
    width: 72px;
    height: 40px;
    border-radius: 4px 4px 0 0;
    background: #15171a;
    margin-left: 18px;
    margin-right: 40px;
  }
  .bodyrow {
    display: flex;
    align-items: flex-start;
  }
  .sidekeys {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 58px;
    padding-top: 90px;
  }
  .ptt {
    height: 56px;
    border-radius: 8px 0 0 8px;
    background: #15171a;
    color: #4a5059;
    display: grid;
    place-items: center;
    font-size: 11px;
    cursor: not-allowed;
  }
  .body {
    background: var(--body);
    border-radius: 26px;
    padding: 22px 24px 26px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    box-shadow: var(--shadow);
  }
  .bezel {
    background: var(--bezel);
    border-radius: 10px;
    padding: 9px;
    width: calc(var(--screen-w) + 18px);
    height: calc(320px * var(--k) + 18px);
  }
  .scaled {
    width: 240px;
    height: 320px;
    transform-origin: 0 0;
  }
  .fkeys {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: 12px;
    align-items: center;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dpad {
    display: grid;
    grid-template-columns: 38px 56px 38px;
    grid-template-rows: 30px 26px 30px;
    gap: 2px;
    background: #23272d;
    border-radius: 12px;
    padding: 4px;
  }
  .digits {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 9px 12px;
  }
  .key {
    position: relative;
    border: 1px solid var(--key-edge);
    border-radius: 8px;
    background: var(--key);
    color: var(--key-text);
    min-height: 40px;
    padding: 3px 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    cursor: pointer;
    transition: background 0.05s, transform 0.05s;
  }
  .key:hover:not(:disabled) {
    border-color: var(--blue);
  }
  .key:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .key.down {
    background: var(--blue);
    color: var(--blue-fg);
    transform: translateY(1px);
  }
  .key.long {
    background: var(--amber);
    color: #1a1400;
  }
  .kl {
    font-weight: 700;
    font-size: 16px;
    line-height: 1;
  }
  .ks {
    font-size: 9px;
    color: #9aa3ae;
    letter-spacing: 0.06em;
  }
  .key.down .ks,
  .key.long .ks {
    color: inherit;
  }
  .fn .kl {
    font-size: 13px;
  }
  .side {
    border-radius: 8px 0 0 8px;
    min-height: 58px;
    padding: 2px;
  }
  .side .kl {
    font-size: 10px;
  }
  .dpad .key {
    min-height: 0;
    padding: 0;
    border-radius: 6px;
  }
  .dpad .kl {
    font-size: 12px;
  }
  @media (max-width: 560px) {
    .body {
      padding: 14px 10px 16px;
      border-radius: 18px;
    }
    .top {
      padding-left: 70px;
    }
    .antenna {
      margin-right: 16px;
    }
  }
  .up {
    grid-column: 1 / 4;
    grid-row: 1;
  }
  .left {
    grid-column: 1;
    grid-row: 2;
  }
  .right {
    grid-column: 3;
    grid-row: 2;
  }
  .down-k {
    grid-column: 1 / 4;
    grid-row: 3;
  }
</style>
