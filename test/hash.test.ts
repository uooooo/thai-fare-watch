import { expect, test } from "bun:test";
import { stableId } from "../src/util/hash";

test("同入力→同ID、異入力→異ID", () => {
	const a = stableId("TYO", "BKK", "2026-08-02", 12345);
	expect(a).toBe(stableId("TYO", "BKK", "2026-08-02", 12345));
	expect(a).not.toBe(stableId("TYO", "BKK", "2026-08-03", 12345));
	expect(a).toMatch(/^[0-9a-f]{12}$/);
});

test("区切りにより連結衝突しない", () => {
	expect(stableId("AB", "1")).not.toBe(stableId("A", "B1"));
});
