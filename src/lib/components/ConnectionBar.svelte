<script lang="ts">
  import { radio } from "../radio.svelte";
  import { theme, type ThemeMode } from "../theme.svelte";
  import { firmware } from "../firmware.svelte";
  import { migrate } from "../migrate.svelte";
  import type { TransportKind } from "../transport";
  import { bridgeEnabled, bridgeUrl } from "../transport/bridge";
  import { DEV_TOOLS } from "../devtools";
  import { isTauri } from "../transport/native";

  // The development bridge (tools/bridge.py) and the demo radio: developer builds only (devtools.ts).
  const bridge = bridgeEnabled();

  const avail = $derived(radio.available());
  let pin = $state("");
  const themeIcon = $derived(theme.mode === "auto" ? "◐" : theme.mode === "light" ? "☀" : "☾");
  const themeName = $derived(theme.mode === "auto" ? `Auto (${theme.shown})` : theme.mode === "light" ? "Light" : "Dark");

  const status = $derived.by(() => {
    if (radio.retrying && (radio.phase === "idle" || radio.phase === "connecting")) return { dot: "busy", text: "Radio lost: reconnecting…" };
    if (radio.phase === "connecting") return { dot: "busy", text: "Connecting…" };
    if (radio.phase === "pin") return { dot: "busy", text: "The radio asks for its PIN" };
    if (radio.phase === "updating") return { dot: "busy", text: migrate.running ? `Finishing the update on ${radio.label}` : `Firmware Update holds ${radio.label}` };
    if (radio.phase === "connected")
      return radio.notAnswering
        ? { dot: "bad", text: `${radio.label}: the radio isn't answering` }
        : { dot: "ok", text: `Connected: ${radio.label}` };
    return { dot: "off", text: "Disconnected" };
  });

  const buttons: { kind: TransportKind; name: string; how: string }[] = [
    { kind: "cable", name: "Connect with cable", how: "Connect over the programming cable" },
    { kind: "bluetooth", name: "Connect with Bluetooth", how: "Connect over the radio's Bluetooth" },
    ...(DEV_TOOLS ? [{ kind: "demo" as TransportKind, name: "Demo radio", how: "A simulated radio (developer builds)" }] : []),
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
    <span class="text" title={radio.retrying ? `${radio.retrying.why} Console opens the same ${radio.label || "connection"} again by itself.` : undefined}>{status.text}</span>
    {#if radio.retrying}<button class="link" onclick={() => radio.stopRetry()} title="Stop reconnecting">Stop</button>{/if}
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
      {#each buttons as b (b.kind)}
        <button
          class="btn"
          class:primary={b.kind === "cable"}
          disabled={avail[b.kind] !== true}
          title={avail[b.kind] === true ? b.how : String(avail[b.kind])}
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
        disabled={firmware.running || migrate.running}
        title={firmware.running || migrate.running ? `${migrate.running ? "Finish the update" : "Firmware Update"} is using the cable: wait until it is done` : undefined}
        onclick={() => radio.disconnect()}>Disconnect</button
      >
    {/if}
    <button class="btn quiet icon" popovertarget="theme-menu" title="Theme: {themeName}" aria-label="Theme: {themeName}">{themeIcon}</button>
    <div id="theme-menu" popover class="theme-menu" role="menu" aria-label="Theme">
      {#each [["light", "☀", "Light"], ["dark", "☾", "Dark"], ["auto", "◐", "Auto (follow the system)"]] as [m, ic, name] (m)}
        <button
          class="btn quiet"
          role="menuitemradio"
          aria-checked={theme.mode === m}
          class:on={theme.mode === m}
          popovertarget="theme-menu"
          popovertargetaction="hide"
          onclick={() => theme.set(m as ThemeMode)}><span class="ic" aria-hidden="true">{ic}</span>{name}</button
        >
      {/each}
    </div>
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
  .note {
    color: var(--sub);
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    font: inherit;
    color: var(--blue);
    cursor: pointer;
    text-decoration: underline;
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
  .icon {
    min-width: 36px;
    font-size: 16px;
    line-height: 1;
  }
  .theme-menu {
    position: fixed;
    inset: auto;
    top: 52px;
    right: 16px;
    margin: 0;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: var(--shadow);
    color: var(--text);
  }
  .theme-menu:popover-open {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .theme-menu .btn {
    justify-content: flex-start;
    text-align: left;
  }
  .theme-menu .btn.on {
    color: var(--blue);
  }
  .theme-menu .ic {
    display: inline-block;
    width: 1.6em;
  }
</style>
