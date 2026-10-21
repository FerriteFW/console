<script lang="ts">
  // Tools > Terminal: the radio's command line over the link (CMD, LINK-34; manual chapter 37). The commands and
  // their output are the radio's own; a refusal shows the radio's status and reason. Enter sends, Up/Down history,
  // Ctrl-L clears. Live View's polling runs on alongside: the link takes one request at a time.
  import { radio } from "../radio.svelte";
  import { terminal } from "../terminal.svelte";
  import { tick } from "svelte";

  const shortcuts: { line: string; what: string }[] = [
    { line: "help", what: "the commands" },
    { line: "slot", what: "the slots now" },
    { line: "get", what: "settings changed from their defaults" },
    { line: "ch 1", what: "channel 1" },
    { line: "gps", what: "the last GPS fix" },
  ];

  let input = $state("");
  let inputEl: HTMLInputElement | undefined = $state();
  let logEl: HTMLDivElement | undefined = $state();
  /** Where Up/Down is in the history: history.length = the line being typed. */
  let at = $state(terminal.history.length);
  let draft = "";

  const connected = $derived(radio.phase === "connected");

  async function send(line: string) {
    input = "";
    draft = "";
    const run = terminal.run(line);
    at = terminal.history.length;
    await run;
    inputEl?.focus();
  }

  function onKey(e: KeyboardEvent) {
    const h = terminal.history;
    if (e.key === "Enter") {
      e.preventDefault();
      if (input.trim() && !terminal.running) void send(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at === h.length) draft = input;
      if (at > 0) input = h[--at];
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (at < h.length) {
        at++;
        input = at === h.length ? draft : h[at];
      }
    } else if (e.key.toLowerCase() === "l" && e.ctrlKey) {
      e.preventDefault();
      terminal.clear();
    }
  }

  // Keep the newest answer in view.
  $effect(() => {
    void terminal.log.length;
    void tick().then(() => logEl?.scrollTo({ top: logEl.scrollHeight }));
  });
</script>

<div class="term">
  <div class="head">
    <h1>Terminal</h1>
    <p class="sub">
      The radio's command line over the link, as on its terminal (<code>:</code> lines, manual chapter 37). Console
      never sends a command that transmits.
    </p>
  </div>

  <div class="shortcuts" role="group" aria-label="Shortcuts">
    {#each shortcuts as s (s.line)}
      <button class="btn" title={s.what} disabled={!connected || terminal.running} onclick={() => send(s.line)}>
        <code>{s.line}</code>
      </button>
    {/each}
    <button class="btn quiet clear" title="Clear the log (Ctrl-L)" onclick={() => terminal.clear()}>Clear</button>
  </div>

  <div class="log" bind:this={logEl} role="log" aria-label="Terminal output" aria-live="polite">
    {#if terminal.log.length === 0}
      <div class="empty">
        {connected ? "Type a command below, or help for the list." : "Connect to the radio to use its terminal."}
      </div>
    {/if}
    {#each terminal.log as e (e.id)}
      <div class="entry {e.kind}" data-kind={e.kind}>
        {#if e.kind === "cmd"}<span class="prompt">:</span>{/if}{#if e.kind === "refused"}<span class="badge">refused</span>{/if}{e.text}
      </div>
    {/each}
    {#if terminal.running}<div class="entry working">…</div>{/if}
  </div>

  <div class="line">
    <span class="prompt">:</span>
    <input
      bind:this={inputEl}
      bind:value={input}
      onkeydown={onKey}
      aria-label="Command"
      placeholder={connected ? "help" : "not connected"}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
    />
    <button class="btn primary" disabled={!input.trim() || terminal.running} onclick={() => send(input)}>Send</button>
  </div>
  <div class="keys"><kbd>Enter</kbd> sends · <kbd>↑</kbd><kbd>↓</kbd> history · <kbd>Ctrl</kbd>+<kbd>L</kbd> clears</div>
</div>

<style>
  .term {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 980px;
    height: calc(100vh - 100px);
    min-height: 420px;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 18px;
  }
  .sub {
    margin: 0;
    color: var(--sub);
    font-size: 13px;
  }
  code {
    font-family: inherit;
  }
  .shortcuts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .shortcuts .btn {
    padding: 5px 12px;
  }
  .clear {
    margin-left: auto;
  }
  .log {
    flex: 1;
    min-height: 200px;
    overflow: auto;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 12px 14px;
    font-size: 13px;
    line-height: 1.45;
  }
  .empty {
    color: var(--dim);
  }
  .entry {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text);
  }
  .entry + .entry {
    margin-top: 2px;
  }
  .entry.cmd {
    color: var(--blue);
    font-weight: 700;
    margin-top: 10px;
  }
  .entry.cmd:first-child {
    margin-top: 0;
  }
  .entry.refused {
    color: var(--amber);
  }
  .entry.error {
    color: var(--red);
  }
  .entry.note {
    color: var(--violet);
  }
  .entry.working {
    color: var(--dim);
  }
  .prompt {
    color: var(--sub);
    margin-right: 6px;
    font-weight: 700;
  }
  .badge {
    display: inline-block;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border: 1px solid var(--amber);
    border-radius: 4px;
    padding: 0 5px;
    margin-right: 8px;
    vertical-align: 1px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 6px 6px 6px 12px;
  }
  .line:focus-within {
    border-color: var(--blue);
  }
  input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 0;
    outline: none;
    color: var(--text);
    font: inherit;
    padding: 4px 0;
  }
  .keys {
    color: var(--dim);
    font-size: 12px;
  }
  @media (max-width: 860px) {
    .term {
      height: calc(100vh - 80px);
    }
  }
</style>
