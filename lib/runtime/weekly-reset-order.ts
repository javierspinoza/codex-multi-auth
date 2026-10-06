import type { QuotaCacheEntry, QuotaCacheWindow } from "../quota-cache.js";

export interface WeeklyResetPreference {
	resetAtMs: number | null;
	resetDay: number | null;
	blocked: boolean;
}

function currentWindow(window: QuotaCacheWindow, entry: QuotaCacheEntry, now: number): boolean {
	const expiry = window.resetAtMs ?? (window.windowMinutes && window.windowMinutes > 0 ? entry.updatedAt + window.windowMinutes * 60_000 : null);
	return expiry === null || now < expiry;
}

/** Rank the weekly window specifically; a depleted 5h window only affects eligibility. */
export function weeklyResetPreference(entry: QuotaCacheEntry | null | undefined, now: number, thresholds: { fiveHours: number; weekly: number }): WeeklyResetPreference {
	const result: WeeklyResetPreference = { resetAtMs: null, resetDay: null, blocked: false };
	if (!entry || !Number.isFinite(entry.updatedAt) || entry.updatedAt > now || ![200, 429].includes(entry.status)) return result;
	for (const window of [entry.primary, entry.secondary]) {
		if (!currentWindow(window, entry, now)) continue;
		const used = window.usedPercent;
		const threshold = window.windowMinutes === 10080 ? thresholds.weekly : thresholds.fiveHours;
		if (typeof used === "number" && Number.isFinite(used) && used >= 0 && used <= 100 && 100 - used <= threshold) result.blocked = true;
		if (window.windowMinutes !== 10080 || typeof window.resetAtMs !== "number" || !Number.isFinite(window.resetAtMs) || window.resetAtMs <= now) continue;
		const date = new Date(window.resetAtMs);
		if (!Number.isFinite(date.getTime())) continue;
		if (result.resetAtMs !== null && result.resetAtMs <= window.resetAtMs) continue;
		result.resetAtMs = window.resetAtMs;
		result.resetDay = date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
	}
	return result;
}

/** Only newer measured capacity can retire a quota blocker; missing windows prove nothing. */
export function quotaConfirmsRecovery(entry: QuotaCacheEntry | null | undefined, now: number, blockedAt: number, thresholds: { fiveHours: number; weekly: number }): boolean {
	return !!entry && entry.status === 200 && entry.updatedAt > blockedAt && entry.updatedAt <= now &&
		[entry.primary, entry.secondary].some(window => currentWindow(window, entry, now) && typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100) &&
		!weeklyResetPreference(entry, now, thresholds).blocked;
}

/** Keep draining within the earliest local reset day; reclaim earlier recovered days. */
export function selectWeeklyResetIndex(candidates: { index: number; preference: WeeklyResetPreference }[], activeIndex: number | null): number | null {
	const available = candidates.filter(candidate => !candidate.preference.blocked);
	if (!available.length) return null;
	const earliestDay = Math.min(...available.map(candidate => candidate.preference.resetDay ?? Infinity));
	// Without a known weekly reset, retain the existing sequential scan order.
	if (!Number.isFinite(earliestDay)) return null;
	const cohort = available.filter(candidate => candidate.preference.resetDay === earliestDay);
	const current = cohort.find(candidate => candidate.index === activeIndex);
	if (current) return current.index;
	cohort.sort((a, b) => (a.preference.resetAtMs ?? Infinity) - (b.preference.resetAtMs ?? Infinity) || a.index - b.index);
	return cohort[0]?.index ?? null;
}
