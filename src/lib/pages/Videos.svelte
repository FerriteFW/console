<script lang="ts">
  // More › Videos: Ferrite's videos from ferritefw.dev (the same list as its /watch/ page), played here. Each shows
  // the keys it presses under the radio's screen, so they double as tutorials.
  import { videos } from "../videos.svelte";

  let playing = $state<string | null>(null);
  void videos.load();
  const current = $derived(videos.list.find((v) => v.file === playing) ?? null);
</script>

<div class="page">
  <section class="card">
    <h1>Videos</h1>
    <p class="sub">Ferrite on the radio, recorded from its own screens. The keys pressed show under the screen, so each one is a short tutorial.</p>
    {#if videos.state === "loading" || videos.state === "idle"}
      <p class="sub">Loading…</p>
    {:else if videos.state === "failed"}
      <p class="sub" data-k="videos-offline">The videos come from ferritefw.dev and couldn't be loaded (no internet?). <a href="https://ferritefw.dev/watch/" target="_blank" rel="noopener">Watch them there</a>, or <button class="link" onclick={() => { videos.state = "idle"; void videos.load(); }}>try again</button>.</p>
    {/if}
  </section>

  {#if videos.state === "ready" && !videos.playable}
    <p class="sub" data-k="videos-external">This computer can't play them here, so each opens on ferritefw.dev in your browser. (On Linux, Console plays videos once GStreamer's video support is installed: gst-plugins-good and an H.264 decoder such as gst-libav.)</p>
  {/if}

  {#if current && videos.playable}
    <section class="card player" aria-label="Playing">
      <h2>{current.title} <span class="len">{current.length}</span></h2>
      {#key current.file}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={videos.mp4(current.file)} poster={videos.poster(current.file)} controls autoplay playsinline data-k="video-player"></video>
      {/key}
      <p class="sub">{current.line}</p>
    </section>
  {/if}

  {#if videos.list.length}
    <ul class="grid" aria-label="Videos">
      {#each videos.list as v (v.file)}
        <li>
          {#if videos.playable}
            <button class="tile" class:on={v.file === playing} onclick={() => (playing = v.file)} data-k="video-tile">
              <img src={videos.poster(v.file)} alt="" loading="lazy" />
              <span class="title">{v.title} <span class="len">{v.length}</span></span>
              <span class="line">{v.line}</span>
            </button>
          {:else}
            <a class="tile" href={videos.mp4(v.file)} target="_blank" rel="noopener" data-k="video-tile">
              <img src={videos.poster(v.file)} alt="" loading="lazy" />
              <span class="title">{v.title} <span class="len">{v.length}</span></span>
              <span class="line">{v.line}</span>
            </a>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .player video {
    display: block;
    width: 100%;
    max-width: 960px;
    border-radius: 8px;
    background: #000;
  }
  .player h2 {
    margin: 0 0 8px;
  }
  .len {
    color: var(--sub);
    font-weight: normal;
    font-size: 0.85em;
  }
  .grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 14px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    text-align: left;
    padding: 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-decoration: none;
    box-sizing: border-box;
  }
  .tile.on {
    border-color: var(--accent, #3b82f6);
  }
  .tile img {
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: 6px;
    background: #000;
  }
  .title {
    font-weight: 600;
  }
  .line {
    font-size: 13px;
    color: var(--sub);
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
</style>
