// Decision 385: until Ferrite 0.9 the link keeps no backward compatibility (the radio and Console ship together),
// so a radio whose HELLO says another protocol is used only to update it. Which side is behind: the radio's
// Ferrite version against Console's own (they are released in lock-step); when that doesn't tell (a development
// build, an odd version), the radio, since every radio on another protocol today runs an older Ferrite.
import { olderThan } from "./version.ts";

export type Mismatch = { radioOld: boolean; text: string };

/** The message for a radio on protocol `theirs` running Ferrite `firmware`, or null when it speaks `ours`. */
export function mismatch(theirs: number, ours: number, firmware: string, consoleVersion: string): Mismatch | null {
  if (theirs === ours) return null;
  const fw = firmware.trim() || "unknown";
  if (olderThan(consoleVersion, firmware)) {
    return { radioOld: false, text: `This radio runs Ferrite ${fw}, newer than this Console understands. Update Console to use it.` };
  }
  return {
    radioOld: true,
    text: `This radio runs Ferrite ${fw}, too old for this Console. Update the radio to use it here: until then Console can only update it.`,
  };
}
