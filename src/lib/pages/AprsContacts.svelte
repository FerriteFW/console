<script lang="ts">
  // APRS › Contacts: the radio's address book (APRS-37 – APRS-42; record 6), in callsign order. Add, rename and
  // delete here; each change is written at once and read back. A CSV of callsign,name lines adds or renames many.
  import { contacts as c, callOk, cleanName, MAX, parseCsv } from "../contacts.svelte";
  import { download } from "../channels.svelte";
  import { radio } from "../radio.svelte";

  const connected = $derived(radio.phase === "connected");
  let call = $state("");
  let name = $state("");
  let search = $state("");
  let fileInput: HTMLInputElement;
  let note = $state("");

  $effect(() => {
    if (connected && !c.loaded && !c.busy) void c.read();
    if (!connected) c.forget();
  });

  const rows = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return c.list.filter((x) => !q || `${x.call} ${x.name}`.toLowerCase().includes(q));
  });
  const callUp = $derived(call.trim().toUpperCase());
  const full = $derived(c.list.length >= MAX && !c.list.some((x) => x.call === callUp));

  async function add() {
    await c.write([{ call: callUp, name: cleanName(name) }]);
    if (!c.error) (call = ""), (name = "");
  }

  async function rename(x: { call: string; name: string }, e: Event) {
    const v = cleanName((e.currentTarget as HTMLInputElement).value);
    if (v !== x.name) await c.write([{ call: x.call, name: v }]);
  }

  async function pick(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    if (!f) return;
    const { ok, bad } = parseCsv(await f.text());
    note = `${ok.length} from ${f.name}${bad.length ? `; ${bad.length} lines without a callsign left out` : ""}.`;
    if (ok.length) await c.write(ok);
  }

  const csv = () => ["callsign,name", ...c.list.map((x) => `${x.call},${x.name}`)].join("\n") + "\n";
</script>

<div class="pg">
  <div class="pg-bar" role="toolbar" aria-label="Contacts">
    <div class="grp">
      <button class="btn" disabled={!connected || !!c.busy} onclick={() => c.read()}>Read from radio</button>
      <button class="btn" disabled={!connected || !!c.busy} onclick={() => fileInput.click()}>Import CSV…</button>
      <input bind:this={fileInput} type="file" accept=".csv,text/csv" hidden onchange={pick} />
      <button class="btn" disabled={!c.loaded} onclick={() => download("contacts.csv", csv(), "text/csv")}>Save CSV</button>
    </div>
    <input type="search" placeholder="Find a contact" aria-label="Find a contact" bind:value={search} />
  </div>

  <div class="pg-status" aria-live="polite" data-status>
    {#if c.busy}
      <span>{c.busy}…</span>
    {:else if c.loaded}
      <span>{c.list.length} of {MAX} contacts.</span>
      {#if note}<span>{note}</span>{/if}
    {:else if !connected}
      <span>Connect to see the radio's contacts.</span>
    {/if}
  </div>
  {#if c.error}<div class="pg-banner">{c.error}</div>{/if}
  {#if c.pending}
    <div class="pending" aria-live="polite">
      <span>{c.pending.list.length} {c.pending.list.length === 1 ? "contact" : "contacts"} from {c.pending.from}, not written yet.</span>
      <button class="btn primary" disabled={!connected || !!c.busy} onclick={() => c.writePending()} title={connected ? "Adds or renames them on the radio" : "Connect a radio to write"}
        >Write to radio</button
      >
      <button class="btn" onclick={() => (c.pending = null)}>Discard</button>
    </div>
  {/if}

  {#if c.loaded}
    <form
      class="add"
      onsubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <input placeholder="Callsign-SSID" aria-label="Callsign" bind:value={call} maxlength="9" />
      <input placeholder="Name" aria-label="Name" bind:value={name} maxlength="12" />
      <button class="btn primary" disabled={!callOk(callUp) || full || !!c.busy}>Add or rename</button>
      {#if full}<span class="dim">128 contacts: delete one first.</span>{/if}
    </form>
    <div class="pg-scroll">
      <table class="tbl" aria-label="Contacts">
        <thead>
          <tr><th>Callsign</th><th>Name</th><th></th></tr>
        </thead>
        <tbody>
          {#each rows as x (x.call)}
            <tr>
              <td class="mono">{x.call}</td>
              <td><input class="cell" value={x.name} maxlength="12" aria-label="Name of {x.call}" onchange={(e) => rename(x, e)} disabled={!!c.busy} /></td>
              <td><button class="btn quiet" disabled={!!c.busy} onclick={() => c.write([], [x.call])}>Delete</button></td>
            </tr>
          {:else}
            <tr><td colspan="3" class="dim">No contacts{search ? " match" : " yet"}.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="dim foot">Compose on the radio lists these first on an empty recipient, then recent conversations, stations heard and the APRS services.</p>
  {/if}
</div>

<style>
  .pending {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    padding: 8px 12px;
    border: 1px solid var(--amber);
    border-radius: 8px;
  }
  .add {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .cell {
    width: 100%;
    min-width: 8em;
  }
  .foot {
    font-size: 12px;
    margin: 0;
  }
</style>
