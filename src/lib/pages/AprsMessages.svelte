<script lang="ts">
  // APRS › Messages: the radio's messages in and out (APRS-13; MSGS, LINK-44) as conversations, one per station,
  // kept current by events (LINK-46). Compose queues one on the radio (MSG_SEND, LINK-45), which sends it by its own
  // rules: now if APRS mode is on, else when it is turned on. States follow from the radio (pending, retrying,
  // acked, failed, rejected, cancelled); one still being tried can be stopped (LINK-49, APRS-13.1).
  import { ago, aprs, when, type MsgRow } from "../aprs.svelte";
  import { radio } from "../radio.svelte";
  import { route } from "../route.svelte";

  let now = $state(Date.now());
  let peer = $state<string | null>(null);
  let to = $state("");
  let text = $state("");
  let note = $state("");
  let sendError = $state("");
  let sending = $state(false);
  const connected = $derived(radio.phase === "connected");

  $effect(() => aprs.use());
  $effect(() => {
    if (connected) aprs.ensure();
  });
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 5000);
    return () => clearInterval(t);
  });
  // #/aprs-messages?to=CALL opens (or starts) that conversation.
  $effect(() => {
    const t = route.params.get("to");
    if (t) {
      peer = t.toUpperCase();
      to = peer;
    }
  });

  const threads = $derived(aprs.threads);
  const open = $derived(threads.find((t) => t.peer === peer) ?? null);
  const left = $derived(67 - new TextEncoder().encode(text).length);

  function pick(p: string) {
    peer = p;
    to = p;
    note = sendError = "";
  }

  function stateText(m: MsgRow) {
    if (m.inbound) return m.state === "unread" ? "new" : "";
    if (m.state === "retrying") return `retrying (${m.tries})`;
    return m.state;
  }
  const stateTag = (m: MsgRow) => ({ acked: "green", failed: "red", rejected: "red", retrying: "amber", pending: "amber", unread: "blue" })[m.state as string] ?? "";

  /** APRS-13.1: stop one of ours that is still being tried. */
  async function stop(m: MsgRow) {
    note = sendError = "";
    try {
      await aprs.stop(m.peer, m.text);
      note = "Stopped: it stays, cancelled.";
    } catch (err) {
      sendError = (err as Error).message;
    }
  }

  async function send(e: SubmitEvent) {
    e.preventDefault();
    note = sendError = "";
    sending = true;
    try {
      note = await aprs.send(to, text);
      peer = to.trim().toUpperCase();
      text = "";
    } catch (err) {
      sendError = (err as Error).message;
    } finally {
      sending = false;
    }
  }
</script>

<div class="pg">
  <div class="pg-bar" role="toolbar" aria-label="Messages">
    <div class="grp">
      <button class="btn" disabled={!connected || !!aprs.busy} onclick={() => aprs.refresh()}>Refresh</button>
      <button class="btn" onclick={() => ((peer = null), (to = ""), (note = sendError = ""))}>New message</button>
    </div>
  </div>
  <div class="pg-status" aria-live="polite" data-status>
    {#if aprs.busy}
      <span>{aprs.busy}…</span>
    {:else if aprs.loaded}
      <span>{aprs.messages.length} messages with {threads.length} stations{radio.subMask & 2 ? " · live" : ""}.</span>
    {:else if !connected}
      <span>Connect to see the radio's messages.</span>
    {/if}
  </div>
  {#if aprs.error}<div class="pg-banner">{aprs.error}</div>{/if}

  <div class="layout">
    <nav class="threads" aria-label="Conversations">
      {#each threads as t (t.peer)}
        <button class="thread" class:on={t.peer === peer} onclick={() => pick(t.peer)} data-peer={t.peer}>
          <span class="who">{t.peer}{#if t.unread}<span class="tag blue">{t.unread}</span>{/if}</span>
          <span class="last">{t.last.inbound ? "" : "You: "}{t.last.text}</span>
          <span class="dim t">{ago(t.last.at, now)}</span>
        </button>
      {:else}
        <p class="sub empty">{aprs.loaded ? "No messages yet." : ""}</p>
      {/each}
    </nav>

    <section class="conv" aria-label={peer ? `Conversation with ${peer}` : "New message"}>
      {#if open}
        <h2>{open.peer}</h2>
        <ol class="bubbles">
          {#each open.messages as m (m.id)}
            <li class:out={!m.inbound} class:fresh={m.at !== null && now - m.at < 10_000} data-state={m.state}>
              <div class="text">{m.text}</div>
              <div class="meta">
                <span title={when(m.at)}>{ago(m.at, now)}</span>
                {#if stateText(m)}<span class={`tag ${stateTag(m)}`}>{stateText(m)}</span>{/if}
                {#if !m.inbound && (m.state === "pending" || m.state === "retrying")}
                  <button class="stop" disabled={!connected} onclick={() => stop(m)} title="No more tries; it stays, cancelled">Stop sending</button>
                {/if}
              </div>
            </li>
          {/each}
        </ol>
      {:else}
        <h2>{peer ?? "New message"}</h2>
        <p class="sub">{peer ? "No messages with this station yet." : "Pick a conversation, or write to a callsign."}</p>
      {/if}

      <form class="compose" onsubmit={send} aria-label="Compose">
        <input class="pg-field to" aria-label="To" placeholder="To (callsign-SSID)" maxlength="9" bind:value={to} disabled={!connected} />
        <input class="pg-field body" aria-label="Message" placeholder="Message" maxlength="67" bind:value={text} disabled={!connected} />
        <span class="dim left" class:over={left < 0}>{left}</span>
        <button class="btn primary" type="submit" disabled={!connected || sending || !to.trim() || !text}>Send</button>
      </form>
      {#if note}<p class="note" role="note">{note} The radio sends it by its own rules (path, power, retries); Dry TX holds the PA if it's on.</p>{/if}
      {#if sendError}<p class="pg-banner">{sendError}</p>{/if}
    </section>
  </div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .threads {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    overflow: hidden;
    max-height: calc(100vh - 230px);
    overflow-y: auto;
  }
  .thread {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 8px;
    text-align: left;
    padding: 10px 12px;
    border: 0;
    border-top: 1px solid var(--line);
    background: none;
    cursor: pointer;
  }
  .thread:first-child {
    border-top: 0;
  }
  .thread.on {
    background: var(--raised);
    box-shadow: inset 3px 0 0 var(--blue);
  }
  .who {
    font-weight: 700;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .last {
    grid-column: 1 / -1;
    color: var(--sub);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t {
    font-size: 11px;
    grid-row: 1;
    grid-column: 2;
  }
  .empty {
    padding: 12px;
    margin: 0;
  }
  .conv {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  .bubbles {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: calc(100vh - 360px);
    overflow-y: auto;
  }
  .bubbles li {
    max-width: 70%;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 12px 12px 12px 4px;
    background: var(--surface);
  }
  .bubbles li.out {
    align-self: flex-end;
    border-radius: 12px 12px 4px 12px;
    background: color-mix(in srgb, var(--blue) 14%, var(--bg));
    border-color: color-mix(in srgb, var(--blue) 40%, var(--line));
  }
  .bubbles li.fresh {
    animation: fresh 2.5s ease-out;
  }
  .text {
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 4px;
    font-size: 11px;
    color: var(--sub);
  }
  .stop {
    margin-left: auto;
    font: inherit;
    font-size: 11px;
    color: var(--sub);
    background: none;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 1px 6px;
    cursor: pointer;
  }
  .stop:hover:not(:disabled) {
    color: var(--text);
  }
  .compose {
    display: grid;
    grid-template-columns: 150px 1fr auto auto;
    gap: 8px;
    align-items: center;
  }
  .left {
    font-size: 12px;
    min-width: 22px;
    text-align: right;
  }
  .left.over {
    color: var(--red);
  }
  .note {
    margin: 0;
    font-size: 13px;
    color: var(--green);
  }
  @media (max-width: 860px) {
    .layout {
      grid-template-columns: 1fr;
    }
    .compose {
      grid-template-columns: 1fr auto;
    }
    .compose .body {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
</style>
