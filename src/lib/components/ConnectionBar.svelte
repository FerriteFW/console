<script lang="ts">
  import { radio } from "../radio.svelte";
  import { firmware } from "../firmware.svelte";
  import type { TransportKind } from "../transport";
  import { bridgeEnabled, bridgeUrl } from "../transport/bridge";
  import { DEV_TOOLS } from "../devtools";
  import { isTauri } from "../transport/native";

  // The development bridge (tools/bridge.py) and the demo radio: developer builds only (devtools.ts).
  const bridge = bridgeEnabled();

  const avail = $derived(radio.available());
  let pin = $state("");
  let theme = $state(document.documentElement.dataset.theme === "light" ? "light" : "dark");

  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* not kept */
    }
  }

  const status = $derived.by(() => {
    if (radio.phase === "connecting") return { dot: "busy", text: "Connecting…" };
    if (radio.phase === "pin") return { dot: "busy", text: "The radio asks for its PIN" };
    if (radio.phase === "updating") return { dot: "busy", text: `Firmware Update holds ${radio.label}` };
    if (radio.phase === "connected")
      return radio.notAnswering
        ? { dot: "bad", text: `${radio.label}: the radio isn't answering` }
        : { dot: "ok", text: `Connected: ${radio.label}` };
    return { dot: "off", text: "Disconnected" };
  });

  const buttons: { kind: TransportKind; name: string }[] = [
    { kind: "cable", name: "Cable" },
    { kind: "bluetooth", name: "Bluetooth" },
    ...(DEV_TOOLS ? [{ kind: "demo" as TransportKind, name: "Demo radio" }] : []),
  ];

  function sendPin(e: SubmitEvent) {
    e.preventDefault();
    void radio.submitPin(pin);
    pin = "";
  }
</script>

<div class="bar">
  <div class="status" role="status" aria-live="polite">
    <span class="dot {status.dot}"></span>
    <span class="text">{status.text}</span>
    {#if radio.keyNote || radio.note}<span class="note" class:warn={!!radio.keyNote}>· {radio.keyNote || radio.note}</span>{/if}
    {#if radio.phase === "connected" && radio.info}
      <!-- The radio in one line; its full details open from Live View's Radio button. -->
      <span class="strip"
        >{[radio.info.callsign || "no callsign", radio.info.firmware, radio.info.build?.name, radio.kind === "cable" && radio.baud ? `${radio.baud} baud` : ""].filter(Boolean).join(" · ")}</span
      >
    {/if}
  </div>

  <div class="actions">
    {#if radio.phase === "idle"}
      <span class="hint">Connect:</span>
      {#each buttons as b (b.kind)}
        <button
          class="btn"
          class:primary={b.kind === "cable"}
          disabled={avail[b.kind] !== true}
          title={avail[b.kind] === true ? `Connect over ${b.name.toLowerCase()}` : String(avail[b.kind])}
          onclick={() => radio.connect(b.kind)}>{b.name}</button
        >
      {/each}
      {#if bridge}
        <button class="btn" title={`Development bridge: ${bridgeUrl()} (tools/bridge.py)`} onclick={() => radio.connectBridge()}>Bridge</button>
      {/if}
    {:else if radio.phase === "pin"}
      <form class="pin" onsubmit={sendPin}>
        <label for="pin">PIN</label>
        <input id="pin" type="password" inputmode="numeric" pattern="[0-9]{'{4,6}'}" maxlength="6" bind:value={pin} autocomplete="off" />
        <button class="btn primary" type="submit">Unlock</button>
        <button class="btn" type="button" onclick={() => radio.disconnect()}>Cancel</button>
      </form>
    {:else}
      <button
        class="btn"
        disabled={firmware.running}
        title={firmware.running ? "Firmware Update is using the cable: wait until it is done" : undefined}
        onclick={() => radio.disconnect()}>Disconnect</button
      >
    {/if}
    <button class="btn quiet" onclick={toggleTheme} title="Light or dark" aria-label="Switch to {theme === 'dark' ? 'light' : 'dark'} theme"
      >{theme === "dark" ? "Light" : "Dark"}</button
    >
  </div>
</div>
{#if radio.error}
  <div class="err" role="alert">{radio.error} <button class="x" aria-label="Dismiss" onclick={() => (radio.error = "")}>×</button></div>
{/if}
{#if radio.pinError}
  <div class="err" role="alert">{radio.pinError}</div>
{/if}

<style>
  .bar {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .text {
    font-weight: 500;
  }
  .note,
  .hint {
    color: var(--sub);
  }
  .note.warn {
    color: var(--amber);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--dim);
    flex: none;
  }
  .dot.ok {
    background: var(--green);
  }
  .dot.busy {
    background: var(--amber);
  }
  .dot.bad {
    background: var(--red);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pin {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .pin input {
    width: 90px;
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    letter-spacing: 0.2em;
  }
  .x {
    float: right;
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
  }
  .err {
    position: absolute;
    top: 100%;
    left: 20px;
    right: 20px;
    margin-top: 6px;
    padding: 8px 12px;
    border: 1px solid var(--red);
    border-radius: 8px;
    background: var(--surface);
    color: var(--red);
  }
  .strip {
    color: var(--sub);
    font-size: 12px;
    margin-left: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
