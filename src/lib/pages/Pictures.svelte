<script lang="ts">
  // SSTV pictures (ferrite manual chapter 27a, SSTV-4): a picture to send, picked here, cropped to 320 x 256 and
  // written to the radio over the cable; the three newest received, read from the radio (either link) and saved as PNG.
  import { canWrite, pictures, type Slot } from "../pictures.svelte";
  import { radio } from "../radio.svelte";
  import { saveBlob } from "../codeplug.svelte";
  import { complete, coverRect, fromRgb565, H, modeName, nameOf, PICTURES_FROM, RECEIVED_SLOTS, RECEIVING, SEND_SLOTS, toRgb565, W } from "../sstv";

  const connected = $derived(radio.phase === "connected");
  const cable = $derived(radio.kind === "cable");
  // LINK-61: before 0.9.1 any raw write starts an update, so the slots to send are shown read-only there
  const writable = $derived(!connected || canWrite());
  const busy = $derived(!!pictures.busy || !!radio.busy);
  const slot = (k: number) => pictures.slots?.[k] ?? null;
  const received = $derived(
    (pictures.slots ?? []).filter((s) => RECEIVED_SLOTS.includes(s.k) && s.header).sort((a, b) => b.header!.seq - a.header!.seq),
  );

  // a picture picked for slot 0, not written yet: its pixels as the radio will hold them
  let picked = $state<Record<number, { px: Uint8Array; name: string } | undefined>>({});
  let pickError = $state("");

  async function pick(k: number, e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    pickError = "";
    try {
      const bmp = await createImageBitmap(f);
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const g = c.getContext("2d")!;
      g.imageSmoothingQuality = "high";
      const r = coverRect(bmp.width, bmp.height);
      g.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
      bmp.close();
      picked[k] = { px: toRgb565(g.getImageData(0, 0, W, H).data), name: f.name };
    } catch {
      pickError = `${f.name} didn't open: pick a PNG or JPEG picture.`;
    }
  }

  async function write(k: number) {
    const p = picked[k];
    if (!p) return;
    await pictures.write(k, p.px, p.name);
    if (!pictures.error) picked[k] = undefined;
  }

  /** The picture drawn into a canvas, `rows` lines of it. */
  function paint(node: HTMLCanvasElement, a: { px: Uint8Array; rows: number }) {
    const draw = ({ px, rows }: { px: Uint8Array; rows: number }) => {
      const n = Math.max(1, Math.min(rows, Math.floor(px.length / (W * 2))));
      node.width = W;
      node.height = n;
      node.getContext("2d")!.putImageData(new ImageData(fromRgb565(px.subarray(0, n * W * 2)), W, n), 0, 0);
    };
    draw(a);
    return { update: draw };
  }

  function savePng(s: Slot, e: Event) {
    const c = (e.currentTarget as HTMLElement).closest(".pic")?.querySelector("canvas");
    const h = s.header!;
    const when = h.time ? new Date(h.time * 1000).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-") : `slot${s.k}`;
    const mode = modeName(h.vis).replace(/\s+/g, "").toLowerCase();
    c?.toBlob((b) => {
      if (b) void saveBlob(`ferrite-sstv-${when}${mode ? `-${mode}` : ""}.png`, b);
    }, "image/png");
  }

  const date = (t: number) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "time unknown");
  const mhz = (f: number) => (f ? `${(f / 1e5).toFixed(4).replace(/0$/, "")} MHz` : "");
  const pct = $derived(pictures.total ? Math.round((100 * pictures.done) / pictures.total) : 0);
</script>

<div class="pg">
  <div class="pg-bar" role="toolbar" aria-label="SSTV">
    <div class="grp">
      <button class="btn" disabled={!connected || busy} onclick={() => pictures.read()} title="Read the pictures on the radio">Read from radio</button>
    </div>
  </div>

  <div class="pg-status" aria-live="polite" data-status>
    {#if pictures.busy}
      <span>{pictures.busy}… {pct} %</span>
    {:else if !connected}
      <span>Connect a radio to see its pictures.</span>
    {:else if !pictures.slots}
      <span>Read from radio shows the pictures on it.</span>
    {/if}
  </div>
  {#if pictures.error}<div class="pg-banner">{pictures.error}</div>{/if}
  {#if pickError}<div class="pg-banner">{pickError}</div>{/if}
  {#if pictures.notice}<div class="pg-banner ok" aria-live="polite">{pictures.notice}</div>{/if}

  <section aria-label="Pictures to send">
    <h3>To send</h3>
    <p class="sub small">
      The picture the radio can send (MENU 0 3 7), besides its test card. A picture is cropped to fill 320 x 256. Writing goes over the cable only.
    </p>
    {#if !writable}<div class="pg-banner warn" data-k="needs-version">Writing pictures needs Ferrite {PICTURES_FROM} or newer.</div>{/if}
    <div class="grid">
      {#each SEND_SLOTS as k (k)}
        {@const s = slot(k)}
        {@const p = picked[k]}
        <div class="pic" data-slot={k}>
          {#if p}
            <canvas use:paint={{ px: p.px, rows: H }} aria-label="Picked picture"></canvas>
            <div class="cap"><b>{nameOf(p.name) || "Picture"}</b> <span class="tag amber">not written</span></div>
          {:else if s?.header && s.px}
            <canvas use:paint={{ px: s.px, rows: s.rows }} aria-label="Picture on the radio"></canvas>
            <div class="cap"><b>{s.header.name || "Picture"}</b> <span class="sub">{date(s.header.time)}</span></div>
          {:else}
            <div class="empty">{pictures.slots ? "Empty" : "Not read yet"}</div>
            <div class="cap sub">Picture {k + 1}</div>
          {/if}
          {#if writable}<div class="acts">
            <label class="btn" class:disabled={busy}
              >Pick a picture…<input type="file" accept="image/png,image/jpeg" hidden disabled={busy} aria-label={`Picture ${k + 1}`} onchange={(e) => pick(k, e)} /></label
            >
            {#if p}
              <button
                class="btn primary"
                disabled={!connected || !cable || busy}
                title={connected && !cable ? "Connect by the cable to write pictures" : "Write this picture to the radio"}
                onclick={() => write(k)}>Write to radio</button
              >
              <button class="btn quiet" disabled={busy} onclick={() => (picked[k] = undefined)}>Cancel</button>
            {/if}
          </div>{/if}
        </div>
      {/each}
    </div>
  </section>

  <section aria-label="Received pictures">
    <h3>Received</h3>
    {#if received.length}
      <div class="grid">
        {#each received as s (s.k)}
          {@const h = s.header!}
          <div class="pic" data-slot={s.k}>
            {#if s.px}<canvas use:paint={{ px: s.px, rows: s.rows }} aria-label="Received picture"></canvas>{/if}
            <div class="cap">
              <b>{modeName(h.vis) || "SSTV"}</b>
              {#if h.lines === RECEIVING}<span class="tag amber">being received</span>{:else if !complete(h)}<span class="tag amber">incomplete</span>{/if}
              <span class="sub">{date(h.time)}{h.freq ? ` · ${mhz(h.freq)}` : ""}</span>
            </div>
            <div class="acts"><button class="btn" disabled={!s.px} onclick={(e) => savePng(s, e)}>Save as PNG</button></div>
          </div>
        {/each}
      </div>
    {:else}
      <p class="sub">{pictures.slots ? "No pictures received yet." : "Read from radio shows the pictures it received (the newest four)."}</p>
    {/if}
  </section>
</div>

<style>
  h3 {
    margin: 8px 0 4px;
    font-size: 15px;
  }
  .small {
    font-size: 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 16px;
  }
  .pic {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
  }
  canvas,
  .empty {
    width: 100%;
    max-width: 320px;
    border-radius: 4px;
    background: var(--bg);
  }
  .empty {
    aspect-ratio: 320 / 256;
    display: grid;
    place-items: center;
    color: var(--dim);
    border: 1px dashed var(--line);
  }
  .cap {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: baseline;
    font-size: 13px;
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  label.btn.disabled {
    opacity: 0.5;
    pointer-events: none;
  }
  .pg-banner.ok {
    border-color: var(--green);
    color: var(--text);
  }
</style>
