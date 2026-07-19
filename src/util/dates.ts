import type { DateRange } from "../types";

const JST_FMT = new Intl.DateTimeFormat("sv-SE", {
	timeZone: "Asia/Tokyo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

export function todayJst(now: Date = new Date()): string {
	return JST_FMT.format(now); // sv-SE => YYYY-MM-DD
}
export function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}
export function windowToRange(
	fromOffset: number,
	toOffset: number,
	now?: Date,
): DateRange {
	const base = todayJst(now);
	return { from: addDays(base, fromOffset), to: addDays(base, toOffset) };
}
export function datesInRange(range: DateRange): string[] {
	const out: string[] = [];
	for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
	return out;
}
export function hoursBetween(isoA: string, isoB: string): number {
	return (new Date(isoB).getTime() - new Date(isoA).getTime()) / 3_600_000;
}
export function monthsTouched(range: DateRange): string[] {
	const out = new Set<string>();
	for (const d of datesInRange(range)) out.add(d.slice(0, 7));
	return [...out];
}
