<script lang="ts">
  // Home: the radio in one line, then the jobs people come for, as big cards. Connected, Update says whether the
  // radio is behind the release bundled with Console.
  import { radio } from "../radio.svelte";
  import { firmware } from "../firmware.svelte";
  import { channels } from "../channels.svelte";

  void firmware.loadBundled();

  const connected = $derived(radio.phase === "connected");
  const mine = $derived(radio.info?.firmware ?? "");
  const latest = $derived(firmware.bundled?.version ?? "");
  // "v0.9.1" and "0.9.1" are the same release.
  const bare = (v: string) => v.trim().replace(/^v/i, "");
  const behind = $derived(connected && !!mine && !!latest && !bare(mine).startsWith(bare(latest)) && mine !== "demo");
  const unwritten = $derived(channels.dirty.any);
</script>

<div class="home">
  <section class="radio">
    {#if connected && radio.info}
      <h1>{radio.info.callsign || "Your radio"}</h1>
      <p>{[radio.info.firmware, radio.info.build?.name, radio.label].filter(Boolean).join(" · ")}</p>
    {:else}
      <h1>No radio connected</h1>
      <p>
        Connect with <button class="link" onclick={() => radio.connect("cable")}>the cable</button> or
        <button class="link" onclick={() => radio.connect("bluetooth")}>Bluetooth</button>, or use the buttons at the top.
      </p>
    {/if}
  </section>

  <div class="cards">
    <a class="card" class:hot={behind} href="#/firmware">
      <span class="name">Update Ferrite</span>
      <span class="line">
        {#if behind}Your radio has {mine}; {latest} is ready to install.
        {:else if connected && latest}Up to date with {latest}.
        {:else}Install a new release over the cable. Your channels and settings stay.{/if}
      </span>
    </a>
    <a class="card" href="#/channels">
      <span class="name">Channels &amp; zones</span>
      <span class="line">{unwritten ? "Changes not written to the radio yet." : "Read, edit and write your channels, or import a CHIRP file."}</span>
    </a>
    <a class="card" href="#/live">
      <span class="name">Live view</span>
      <span class="line">The radio's screen on the computer, with its keys and knob.</span>
    </a>
    <a class="card" href="#/aprs-messages">
      <span class="name">APRS</span>
      <span class="line">Messages, stations heard and the map.</span>
    </a>
    <a class="card" href="#/settings">
      <span class="name">Radio settings</span>
      <span class="line">Every setting in the radio's menu, by its number.</span>
    </a>
    <a class="card" href="#/install">
      <span class="name">New radio? Install Ferrite</span>
      <span class="line">From Radtel's firmware: a full backup first, then Ferrite. Going back is built in.</span>
    </a>
  </div>

  <p class="foot"><a href="https://manual.ferritefw.dev" target="_blank" rel="noopener">User guide ↗</a></p>
</div>

<style>
  .home {
    max-width: 880px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .radio h1 {
    margin: 0;
    font-size: 24px;
  }
  .radio p {
    margin: 6px 0 0;
    color: var(--sub);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 18px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
  }
  .card:hover {
    border-color: var(--blue);
  }
  .card.hot {
    border-color: var(--blue);
    background: var(--raised);
  }
  .name {
    font-size: 16px;
    font-weight: 600;
  }
  .card.hot .name {
    color: var(--blue);
  }
  .line {
    color: var(--sub);
    font-size: 13px;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--blue);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }
  .foot {
    margin: 0;
    font-size: 13px;
  }
</style>
