import { describe, expect, test } from "bun:test";
import {
	addDays,
	datesInRange,
	hoursBetween,
	monthsTouched,
	todayJst,
	windowToRange,
} from "../src/util/dates";

describe("dates (JST)", () => {
	// 2026-07-18T20:00:00Z = JSTでは 2026-07-19 05:00
	const now = new Date("2026-07-18T20:00:00Z");
	test("todayJstはUTC日付でなくJST日付を返す", () => {
		expect(todayJst(now)).toBe("2026-07-19");
	});
	test("windowToRange immediate(0..1)", () => {
		expect(windowToRange(0, 1, now)).toEqual({
			from: "2026-07-19",
			to: "2026-07-20",
		});
	});
	test("addDaysは月跨ぎ可", () => {
		expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
	});
	test("datesInRangeは両端含む", () => {
		expect(datesInRange({ from: "2026-07-30", to: "2026-08-01" })).toEqual([
			"2026-07-30",
			"2026-07-31",
			"2026-08-01",
		]);
	});
	test("hoursBetweenはタイムゾーン込みで計算", () => {
		expect(
			hoursBetween("2026-08-02T10:00:00+09:00", "2026-08-02T16:30:00+07:00"),
		).toBe(8.5);
	});
	test("monthsTouched", () => {
		expect(monthsTouched({ from: "2026-07-19", to: "2026-08-18" })).toEqual([
			"2026-07",
			"2026-08",
		]);
	});
});
