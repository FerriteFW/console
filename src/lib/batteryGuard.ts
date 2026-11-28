// Decision 477 (console#127, from ferrite#281: an install at 25% failed part way): Console checks the radio's battery
// before it writes firmware or stock data. Below 50% it warns and asks first; below 30% it refuses. UPD-29, BACKUP-7.5.

/** Below this, a warning: go on only when the owner says so. */
export const BATTERY_WARN = 50;
/** Below this, refused until the radio is charged. */
export const BATTERY_REFUSE = 30;

export type BatteryCheck =
  | { level: "ok"; pct: number }
  /** Console couldn't read it (a radio that doesn't answer STATE): the advice alone, nothing held. */
  | { level: "unknown"; text: string }
  | { level: "warn"; pct: number; text: string }
  | { level: "refuse"; pct: number; text: string };

/** The check for `pct` (the radio's battery, percent; null when unread) before `what` ("updating", ...). */
export function batteryCheck(pct: number | null | undefined, what: string): BatteryCheck {
  if (pct == null || !Number.isFinite(pct)) {
    return { level: "unknown", text: `Charge the radio to over ${BATTERY_WARN}% before ${what}: Console can't read its battery.` };
  }
  const p = Math.round(pct);
  if (p < BATTERY_REFUSE) {
    return {
      level: "refuse",
      pct: p,
      text: `The battery is at ${p}%: charge the radio to over ${BATTERY_WARN}% before ${what}. A radio that goes flat part way can be left without working firmware.`,
    };
  }
  if (p < BATTERY_WARN) {
    return { level: "warn", pct: p, text: `The battery is at ${p}%: charge the radio to over ${BATTERY_WARN}% before ${what} if you can.` };
  }
  return { level: "ok", pct: p };
}

/** Whether `c` lets the step start: a warning only once the owner has said to go on. */
export const batteryAllows = (c: BatteryCheck, goOn: boolean): boolean => c.level === "ok" || c.level === "unknown" || (c.level === "warn" && goOn);
