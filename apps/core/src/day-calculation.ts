export type DayRecordKind = "elapsed" | "countdown" | "cycle";
export type DayRecordState = "normal" | "threshold_reached" | "future" | "upcoming" | "today" | "past" | "due" | "overdue";
export type DayAttentionLevel = "none" | "info" | "warning" | "critical";

type ElapsedInput = { kind: "elapsed"; anchorDate: string; attentionAfterDays: number | null };
type CountdownInput = { kind: "countdown"; anchorDate: string; attentionBeforeDays: number | null };
type CycleInput = { kind: "cycle"; anchorDate: string; cycleDays: number; nextDueDate: string; attentionBeforeDays: number | null };

type ComputedBase = { today: string; state: DayRecordState; attentionLevel: DayAttentionLevel; isAttentionRequired: boolean };
export type ElapsedComputed = ComputedBase & { elapsedDays: number; remainingDays: number | null };
export type CountdownComputed = ComputedBase & { remainingDays: number };
export type CycleComputed = ComputedBase & { elapsedDays: number; remainingDays: number; progressRatio: number };

export function dateOrdinal(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function daysBetween(from: string, to: string): number {
  return dateOrdinal(to) - dateOrdinal(from);
}

export function addDateDays(date: string, days: number): string {
  const result = new Date((dateOrdinal(date) + days) * 86_400_000);
  return result.toISOString().slice(0, 10);
}

export function spaceToday(timeZone: string, instant = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function computeDayRecord(input: ElapsedInput, today: string): ElapsedComputed;
export function computeDayRecord(input: CountdownInput, today: string): CountdownComputed;
export function computeDayRecord(input: CycleInput, today: string): CycleComputed;
export function computeDayRecord(input: ElapsedInput | CountdownInput | CycleInput, today: string): ElapsedComputed | CountdownComputed | CycleComputed {
  if (input.kind === "elapsed") {
    const elapsedDays = daysBetween(input.anchorDate, today);
    const remainingDays = input.attentionAfterDays === null ? null : input.attentionAfterDays - elapsedDays;
    const attention = remainingDays !== null && remainingDays <= 0;
    return {
      today,
      elapsedDays,
      remainingDays,
      state: attention ? "threshold_reached" : "normal",
      attentionLevel: attention ? "warning" : "none",
      isAttentionRequired: attention,
    };
  }

  if (input.kind === "countdown") {
    const remainingDays = daysBetween(today, input.anchorDate);
    if (remainingDays < 0) return { today, remainingDays, state: "past", attentionLevel: "critical", isAttentionRequired: true };
    if (remainingDays === 0) return { today, remainingDays, state: "today", attentionLevel: "warning", isAttentionRequired: true };
    const upcoming = input.attentionBeforeDays !== null && remainingDays <= input.attentionBeforeDays;
    return { today, remainingDays, state: upcoming ? "upcoming" : "future", attentionLevel: upcoming ? "info" : "none", isAttentionRequired: upcoming };
  }

  const elapsedDays = daysBetween(input.anchorDate, today);
  const remainingDays = daysBetween(today, input.nextDueDate);
  const progressRatio = Math.round((elapsedDays / input.cycleDays) * 10_000) / 10_000;
  if (remainingDays < 0) return { today, elapsedDays, remainingDays, progressRatio, state: "overdue", attentionLevel: "critical", isAttentionRequired: true };
  if (remainingDays === 0) return { today, elapsedDays, remainingDays, progressRatio, state: "due", attentionLevel: "critical", isAttentionRequired: true };
  const upcoming = input.attentionBeforeDays !== null && remainingDays <= input.attentionBeforeDays;
  return { today, elapsedDays, remainingDays, progressRatio, state: upcoming ? "upcoming" : "normal", attentionLevel: upcoming ? "warning" : "none", isAttentionRequired: upcoming };
}
