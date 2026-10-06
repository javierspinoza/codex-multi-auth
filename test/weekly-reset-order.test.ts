import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { quotaConfirmsRecovery, selectWeeklyResetIndex, weeklyResetPreference } from "../lib/runtime/weekly-reset-order.js";
import type { QuotaCacheEntry } from "../lib/quota-cache.js";

const now = Date.parse("2026-10-06T20:00:00Z");
const thresholds = { fiveHours: 2, weekly: 2 };
const entry = (reset = "2026-10-09T21:00:00Z", used = 10): QuotaCacheEntry => ({ updatedAt: now, status: 200, model: "fixture", primary: {}, secondary: { usedPercent: used, windowMinutes: 10080, resetAtMs: Date.parse(reset) } });
beforeEach(() => vi.stubEnv("TZ", "America/Bogota"));
afterEach(() => vi.unstubAllEnvs());

it("orders by the weekly reset even when the five-hour limit resets much sooner", () => {
	const laterWeek = entry("2026-10-10T20:00:00Z");
	laterWeek.primary = { usedPercent: 20, windowMinutes: 300, resetAtMs: now + 60_000 };
	const earlier = weeklyResetPreference(entry(), now, thresholds);
	const later = weeklyResetPreference(laterWeek, now, thresholds);
	expect(selectWeeklyResetIndex([{ index: 0, preference: earlier }, { index: 1, preference: later }], 1)).toBe(0);
});

it("keeps draining a healthy primary within the same local reset day", () => {
	const candidates = [entry("2026-10-09T21:00:00Z"), entry("2026-10-10T03:00:00Z")].map((quota, index) => ({ index, preference: weeklyResetPreference(quota, now, thresholds) }));
	expect(candidates.map(candidate => candidate.preference.resetDay)).toEqual([20261009, 20261009]);
	expect(selectWeeklyResetIndex(candidates, 1)).toBe(1);
	expect(selectWeeklyResetIndex(candidates, null)).toBe(0);
});

it("skips exhausted earlier days and reclaims them after five-hour recovery", () => {
	const early = entry();
	early.primary = { usedPercent: 100, windowMinutes: 300, resetAtMs: now + 60_000 };
	const late = entry("2026-10-10T20:00:00Z");
	const candidates = (at: number) => [early, late].map((quota, index) => ({ index, preference: weeklyResetPreference(quota, at, thresholds) }));
	expect(selectWeeklyResetIndex(candidates(now), 1)).toBe(1);
	expect(selectWeeklyResetIndex(candidates(now + 60_001), 1)).toBe(0);
});

it.each(["primary", "secondary"] as const)("uses a weekly-only %s limit and blocks at two percent", slot => {
	const quota = entry();
	quota.primary = {}; quota.secondary = {};
	quota[slot] = { usedPercent: 97, windowMinutes: 10080, resetAtMs: Date.parse("2026-10-09T21:00:00Z") };
	expect(weeklyResetPreference(quota, now, thresholds)).toMatchObject({ resetDay: 20261009, blocked: false });
	quota[slot].usedPercent = 98;
	expect(weeklyResetPreference(quota, now, thresholds).blocked).toBe(true);
});

it("does not guess that an unknown window is weekly or prioritize an expired weekly reset", () => {
	const unknown = entry(); unknown.secondary.windowMinutes = undefined;
	expect(weeklyResetPreference(unknown, now, thresholds).resetDay).toBeNull();
	expect(weeklyResetPreference(entry("2026-10-05T21:00:00Z"), now, thresholds).resetDay).toBeNull();
	expect(selectWeeklyResetIndex([{ index: 0, preference: weeklyResetPreference(unknown, now, thresholds) }], 0)).toBeNull();
});

it("requires a newer measured healthy observation to confirm recovery", () => {
	expect(quotaConfirmsRecovery(entry(), now, now, thresholds)).toBe(false);
	expect(quotaConfirmsRecovery(entry(), now, now - 1, thresholds)).toBe(true);
	expect(quotaConfirmsRecovery(entry(undefined, 98), now, now - 1, thresholds)).toBe(false);
	expect(quotaConfirmsRecovery({ ...entry(), primary: {}, secondary: {} }, now, now - 1, thresholds)).toBe(false);
});
