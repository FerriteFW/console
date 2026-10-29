// Release signatures (core/src/signature.rs): Ferrite's CI signs each release image X.btf into X.btf.minisig. A
// signature that verifies with Ferrite's key is a release; one that doesn't is refused like a failed image check;
// no signature is someone's own build (tools/mkbtf.sh), allowed and shown as not signed.
import { signatureCheck } from "./core";

export type Signed = { kind: "signed"; comment: string } | { kind: "unsigned" } | { kind: "bad"; error: string };

/** The image's signature state; the core must be loaded. */
export function signatureOf(image: Uint8Array, minisig: string | null): Signed {
  if (minisig === null) return { kind: "unsigned" };
  const c = signatureCheck(image, minisig);
  return c.signed !== null ? { kind: "signed", comment: c.signed } : { kind: "bad", error: c.error ?? "it doesn't verify" };
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
