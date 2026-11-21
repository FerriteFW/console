// Release signatures (core/src/signature.rs): Ferrite's CI signs each release image X.btf into X.btf.minisig. A
// signature that verifies with Ferrite's key is a release; one that doesn't is refused like a failed image check;
// no signature is someone's own build (tools/mkbtf.sh), taken only with the developer option "Allow unsigned files"
// (as an unsigned .ffw, UPD-21), and never as a release (UPD-27, a review of Nov 20, 2026: a bare .btf, the
// reader and the restorer were taken unsigned, labelled only "Not signed").
import { signatureCheck } from "./core";

export type Signed = { kind: "signed"; comment: string } | { kind: "unsigned" } | { kind: "bad"; error: string };

/** The image's signature state; the core must be loaded. */
export function signatureOf(image: Uint8Array, minisig: string | null): Signed {
  if (minisig === null) return { kind: "unsigned" };
  const c = signatureCheck(image, minisig);
  return c.signed !== null ? { kind: "signed", comment: c.signed } : { kind: "bad", error: c.error ?? "it doesn't verify" };
}

/** UPD-27: why the image can't be used, or null: a bad signature never; none, only with `allowUnsigned` (a local
 *  build: release Consoles bundle signed images) and never as a `release` downloaded from the update feed. */
export function signatureProblem(s: Signed, allowUnsigned: boolean, release = false): string | null {
  if (s.kind === "bad") return signatureText(s);
  if (s.kind === "unsigned" && release) return "The release isn't signed by Ferrite: Console won't use it.";
  if (s.kind === "unsigned" && !allowUnsigned) return "unsigned: only a release signed with Ferrite's key installs; your own build needs Allow unsigned files (Advanced).";
  return null;
}

/** What the page says about it. */
export function signatureText(s: Signed): string {
  if (s.kind === "signed") return `Signed by Ferrite: ${s.comment}`;
  if (s.kind === "unsigned") return "Not signed: not a Ferrite release";
  return `Bad signature: ${s.error}. Console won't use this image.`;
}

/**
 * The picked files as an image and its signature: the first .btf, and X.btf.minisig beside it (or the only .minisig
 * picked). `btf` is undefined when no .btf was picked.
 */
export function splitPicked(files: File[]): { btf: File | undefined; sig: File | undefined } {
  const btf = files.find((f) => /\.btf$/i.test(f.name));
  const sigs = files.filter((f) => /\.minisig$/i.test(f.name));
  const named = btf && sigs.find((f) => f.name.toLowerCase() === `${btf.name}.minisig`.toLowerCase());
  return { btf, sig: named ?? (sigs.length === 1 ? sigs[0] : undefined) };
}
