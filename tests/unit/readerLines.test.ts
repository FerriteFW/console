// src/lib/readerLines.ts: the reader's lines the backup waits for count only once whole (FerriteFW/console#95 item 4),
// `?  (help)` only right after the command's echo (#88), the prompt at the end of what came, and the quiet wait
// before a NAK (#90).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fdumpReadyRe, FDUMP_RESULT_RE, MDUMP_MARKER_RE, PROMPT_RE, quiet, resultReason } from "../../src/lib/readerLines.ts";

const CMD = "fdumpz 0x0 0x400000 230400\r";

test("readerLines: the ready line counts once whole", () => {
  const re = fdumpReadyRe(CMD);
  const line = "fdump 000000 400000 230400 ready, clock 240 MHz";
  assert.equal(`fdumpz 0x0 0x400000 230400\r\n${line}`.match(re), null);
  assert.equal(`fdumpz 0x0 0x400000 230400\r\n${line}\r\n`.match(re)?.[0], line);
});

test("readerLines: a refusal split across reads waits for its end (its reason intact)", () => {
  const re = fdumpReadyRe(CMD);
  const refusal = "fdump: range 000000+400000 outside the 2048 KB chip";
  assert.equal(`${CMD}\r\nfdump: range 000000+4000`.match(re), null);
  assert.equal(`${CMD}\n${refusal}\r\n> `.match(re)?.[0], refusal);
});

test("readerLines: ?  (help) is the answer only right after the command's echo", () => {
  const re = fdumpReadyRe(CMD);
  assert.ok("fdumpz 0x0 0x400000 230400\r\n?  (help)\r\n> ".match(re)?.[0].endsWith("?  (help)"));
  // A late `?` from bytes the reader took as a line of their own (sync bytes after a failed try), before the echo.
  assert.equal("FDS1CAN\r\n?  (help)\r\n> fdumpz 0x0 0x400000 230400\r\n".match(re), null);
  assert.equal("> ?  (help)\r\n".match(re), null);
  // hwtest's own answer to a command it lacks.
  assert.ok("fdumpz: ?\r\n".match(re));
});

test("readerLines: the result line and its reason", () => {
  const stopped = "\r\nfdump stopped at 010000: no acknowledgement; back to 115200 baud\r\n";
  assert.equal("\r\nfdump stopped at 010000: no ack".match(FDUMP_RESULT_RE), null);
  const m = stopped.match(FDUMP_RESULT_RE)!;
  assert.equal(resultReason(m[0]), "fdump stopped at 010000: no acknowledgement");
  assert.ok("fdump end crc32 1A2B3C4D, 4194304 bytes in 256 blocks, 0 resends, 61234 ms\r\n".match(FDUMP_RESULT_RE));
});

test("readerLines: the marker's mdump refusal waits for its end", () => {
  assert.equal("mdump 0x080F0000 16\r\nmdump: 0x08000000-0x0807".match(MDUMP_MARKER_RE), null);
  assert.equal("mdump: 0x08000000-0x0807FFFF only\r\n".match(MDUMP_MARKER_RE)?.[0], "mdump: 0x08000000-0x0807FFFF only");
  assert.ok("80F0000:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF*F0\r\ndump: end\r\n".match(MDUMP_MARKER_RE));
});

test("readerLines: the prompt counts only at the end of what came", () => {
  assert.ok(PROMPT_RE.test("\r\n> "));
  assert.ok(PROMPT_RE.test("> "));
  assert.ok(!PROMPT_RE.test("\r\n> \r\nfdump stopped at 000000: no sync"));
  assert.ok(!PROMPT_RE.test("fdump 000000 400000 230400 ready> "));
});

test("readerLines: quiet waits for the line to go quiet, at most its limit", async () => {
  // A fake clock, 5 ms on at every look; bytes keep coming until 50 ms, then stop: quiet 30 ms after the last.
  let t = 0;
  const now = () => (t += 5);
  const heard = () => Math.min(t, 50);
  assert.equal(await quiet(heard, 30, 1000, now), true);
  assert.ok(t >= 80 && t < 120, `quiet at ${t}`);
  // Never quiet: gives up at the limit.
  t = 0;
  assert.equal(await quiet(() => t, 30, 100, now), false);
  assert.ok(t >= 100 && t < 140, `gave up at ${t}`);
});
