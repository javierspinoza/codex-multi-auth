import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { chooseAccount } from "../lib/runtime/rotation-account-selection.js";
import { SequentialAccountCoordinator } from "../lib/runtime/sequential-account-coordinator.js";
import { inferenceAccountKey } from "../lib/runtime/inference-activity.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "cma-sequential-"));
	AccountManager.resetVolatileRuntimeState();
});
afterEach(async () => { vi.useRealTimers(); await removeWithRetry(dir, { recursive: true, force: true }); });

function manager(activeIndex: number, reverse = false): AccountManager {
	const accounts = ["one", "two", "three"].map(id => ({ accountId: id, email: `${id}@example.test`, refreshToken: `fixture-${id}`, addedAt: 1, lastUsed: 1, enabled: true }));
	if (reverse) accounts.reverse();
	return new AccountManager(undefined, { version: 3, activeIndex, activeIndexByFamily: { codex: activeIndex }, accounts });
}
function select(coordinator: SequentialAccountCoordinator, pool: AccountManager, attemptedIndexes = new Set<number>()) {
	return coordinator.select({ manager: pool, family: "codex", affinityGeneration: 0, select: () => chooseAccount({
		accountManager: pool, family: "codex", model: null, sessionAffinityStore: null, sessionKey: null,
		pinnedIndex: null, attemptedIndexes, now: Date.now(), policy: null, schedulingStrategy: "sequential",
	}) });
}

it("makes separate proxies follow the first primary despite different startup selections", async () => {
	const path = join(dir, "shared.json");
	const first = manager(1), second = manager(0);
	expect((await select(new SequentialAccountCoordinator(path), first))?.index).toBe(1);
	expect((await select(new SequentialAccountCoordinator(path), second))?.index).toBe(1);
	expect(second.getActiveIndexForFamily("codex")).toBe(1);
	const state = JSON.parse(await fs.readFile(path, "utf8"));
	expect(state.accountKey).toBe(inferenceAccountKey(first.getAccountByIndex(1)!));
	expect(JSON.stringify(state)).not.toContain("example.test");
	if (process.platform !== "win32") expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
});

it("moves forward on exhaustion and other proxies adopt the new primary without revisiting the old one", async () => {
	const path = join(dir, "shared.json");
	const first = manager(1), second = manager(0);
	await select(new SequentialAccountCoordinator(path), first);
	first.markRateLimitedWithReason(first.getAccountByIndex(1)!, 60_000, "codex", "quota");
	expect((await select(new SequentialAccountCoordinator(path), first))?.index).toBe(2);
	expect((await select(new SequentialAccountCoordinator(path), second))?.index).toBe(2);
	// Recovery of the old primary does not interrupt the new account's drain.
	expect((await select(new SequentialAccountCoordinator(path), manager(1)))?.index).toBe(2);
});

it("publishes a retry fallback so new projects follow it", async () => {
	const path = join(dir, "shared.json");
	const first = manager(0);
	await select(new SequentialAccountCoordinator(path), first);
	expect((await select(new SequentialAccountCoordinator(path), first, new Set([0])))?.index).toBe(1);
	expect((await select(new SequentialAccountCoordinator(path), manager(0)))?.index).toBe(1);
});

it("matches the shared primary by identity after account reordering", async () => {
	const path = join(dir, "shared.json");
	await select(new SequentialAccountCoordinator(path), manager(0));
	expect((await select(new SequentialAccountCoordinator(path), manager(0, true)))?.index).toBe(2);
});

it("serializes simultaneous first selections and avoids rewriting a healthy primary", async () => {
	const path = join(dir, "shared.json");
	const selected = await Promise.all([select(new SequentialAccountCoordinator(path), manager(1)), select(new SequentialAccountCoordinator(path), manager(2))]);
	expect(selected[0]?.accountId).toBe(selected[1]?.accountId);
	const before = await fs.readFile(path, "utf8");
	await select(new SequentialAccountCoordinator(path), manager(0));
	expect(await fs.readFile(path, "utf8")).toBe(before);
});

it("keeps independent account pools isolated", async () => {
	expect((await select(new SequentialAccountCoordinator(join(dir, "a.json")), manager(0)))?.index).toBe(0);
	expect((await select(new SequentialAccountCoordinator(join(dir, "b.json")), manager(2)))?.index).toBe(2);
});

it("preserves a simultaneous network cooldown even when quota has recovered", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const now = Date.now();
	const pool = manager(0), coordinator = new SequentialAccountCoordinator(join(dir, "shared.json"));
	await select(coordinator, pool);
	await coordinator.recordUnavailable(pool.getAccountByIndex(0)!, now + 60_000, "quota");
	await coordinator.recordUnavailable(pool.getAccountByIndex(0)!, now + 10_000, "failure");
	const check = (blocked: boolean) => coordinator.select({ manager: pool, family: "codex", affinityGeneration: 0, canRecover: () => true,
		select: indexes => { expect(indexes.has(0)).toBe(blocked); return pool.getAccountByIndex(1); },
	});
	await check(true);
	vi.setSystemTime(now + 10_001);
	await check(false);
});
