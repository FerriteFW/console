<script lang="ts">
  // The pixel mirror's slot (LINK-18): the radio's real 240 x 320 pixels, once the cable's SCREEN message exists
  // (another agent is building it in the firmware). A frame source hands it RGB565 pixels (the panel's own format)
  // in rectangles; this draws them. Nothing feeds it yet: LiveView.svelte uses ReadbackScreen until a source exists.
  //
  // TODO(SCREEN): add a `screen.ts` source next to link.ts that subscribes to SCREEN and calls `draw` per rectangle.
  export type Rect = { x: number; y: number; w: number; h: number; rgb565: Uint16Array };

  let canvas: HTMLCanvasElement | undefined = $state();

  /** Draws one rectangle of RGB565 pixels. */
  export function draw(r: Rect) {
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(r.w, r.h);
    for (let i = 0; i < r.w * r.h; i++) {
      const c = r.rgb565[i];
      img.data[4 * i] = ((c >> 11) & 31) * 255 / 31;
      img.data[4 * i + 1] = ((c >> 5) & 63) * 255 / 63;
      img.data[4 * i + 2] = (c & 31) * 255 / 31;
      img.data[4 * i + 3] = 255;
    }
    ctx.putImageData(img, r.x, r.y);
  }
</script>

<canvas bind:this={canvas} width="240" height="320" aria-label="The radio's screen, mirrored pixel for pixel"></canvas>

<style>
  canvas {
    display: block;
    width: 240px;
    height: 320px;
    image-rendering: pixelated;
    background: #000;
  }
</style>
