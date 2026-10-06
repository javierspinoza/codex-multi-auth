import { describe, expect, it, vi } from "vitest";
import { runListHolaCommand, type ListHolaDeps } from "../lib/codex-manager/list-hola.js";
import { AccountGreetingError, type AccountGreetingResult } from "../lib/runtime/account-greeting.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const now = Date.now();
function pool(): AccountStorageV3 {
	return { version: 3, activeIndex: 1, activeIndexByFamily: { codex: 1 }, pinnedAccountIndex: 1, affinityGeneration: 4, accounts: [1, 2, 3].map(index => ({ accountId: `fixture-${index}`, accountIdSource: "manual", email: `${index}@example.test`, refreshToken: `fixture-refresh-${index}`, accessToken: `fixture-access-${index}`, expiresAt: now + 3_600_000, addedAt: index, lastUsed: index })) };
}
const greeting = (): AccountGreetingResult => ({ text: "¡Hola!", responseId: "resp_fixture", quota: null, usage: { inputTokens: 9, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 12 } });
function deps(overrides: Partial<ListHolaDeps> = {}): ListHolaDeps {
	return { now: () => now, refresh: vi.fn(async () => ({ type: "success", access: "fixture-new-access", refresh: "fixture-new-refresh", expires: now + 3_600_000 })), persistCredentials: vi.fn(async (account, result) => ({ ...account, accessToken: result.access, refreshToken: result.refresh, expiresAt: result.expires })), sendGreeting: vi.fn(async () => greeting()), appendUsage: vi.fn(async () => undefined), recordActivity: vi.fn(async () => undefined), recordQuota: vi.fn(async () => undefined), ...overrides };
}
function logs(json = false) { return { json, logInfo: vi.fn(), logError: vi.fn() }; }

describe("list --hola", () => {
	it("greets every saved account in storage order, sequentially, preserving pins and disabled flags", async () => {
		const storage = pool();
		storage.accounts[1]!.enabled = false;
		const baseline = JSON.stringify(storage);
		let running = false;
		const order: string[] = [];
		const d = deps({ sendGreeting: vi.fn(async ({ accountId }) => {
			expect(running).toBe(false);
			running = true;
			order.push(accountId);
			await Promise.resolve();
			running = false;
			return greeting();
		}) });
		const output = logs();
		expect(await runListHolaCommand(storage, output, d)).toBe(0);
		expect(order).toEqual(["fixture-1", "fixture-2", "fixture-3"]);
		expect(JSON.stringify(storage)).toBe(baseline);
		expect(d.refresh).not.toHaveBeenCalled();
		expect(d.appendUsage).toHaveBeenCalledTimes(3);
		expect(d.appendUsage).toHaveBeenCalledWith(expect.objectContaining({ source: "cli", operation: "responses", model: "gpt-6-luna", outcome: "success", accountIndex: 0, inputTokens: 9, outputTokens: 3 }));
		expect(output.logInfo.mock.calls.flat().join("\n")).toContain("Saludos completados: 3/3");
	});

	it("renews expired credentials and saves them before dispatching the greeting", async () => {
		const storage = pool();
		storage.accounts[0]!.expiresAt = now - 1;
		const d = deps();
		expect(await runListHolaCommand(storage, logs(), d)).toBe(0);
		expect(d.refresh).toHaveBeenCalledWith("fixture-refresh-1");
		expect(d.persistCredentials).toHaveBeenCalledTimes(1);
		expect(vi.mocked(d.persistCredentials).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.sendGreeting).mock.invocationCallOrder[0]!);
		expect(d.sendGreeting).toHaveBeenNthCalledWith(1, { accountId: "fixture-1", accessToken: "fixture-new-access" });
	});

	it("continues after a failed account and returns one JSON result with a failing exit code", async () => {
		const d = deps({ sendGreeting: vi.fn().mockRejectedValueOnce(new AccountGreetingError("Sin cuota.", "http_429", 429)).mockResolvedValue(greeting()) });
		const output = logs(true);
		expect(await runListHolaCommand(pool(), output, d)).toBe(1);
		expect(d.sendGreeting).toHaveBeenCalledTimes(3);
		expect(output.logInfo).toHaveBeenCalledTimes(1);
		const result = JSON.parse(output.logInfo.mock.calls[0]![0]);
		expect(result).toMatchObject({ model: "gpt-6-luna", prompt: "hola", summary: { total: 3, completed: 2, failed: 1 } });
		expect(result.results.map((row: { status: string }) => row.status)).toEqual(["error", "ok", "ok"]);
		expect(d.appendUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ outcome: "failure", statusCode: 429 }));
	});

	it("renews once on a rejected 401 and sends again on the same account", async () => {
		const d = deps({ sendGreeting: vi.fn().mockRejectedValueOnce(new AccountGreetingError("Session expired", "http_401", 401)).mockResolvedValue(greeting()) });
		expect(await runListHolaCommand(pool(), logs(), d)).toBe(0);
		expect(d.refresh).toHaveBeenCalledTimes(1);
		expect(d.sendGreeting).toHaveBeenNthCalledWith(1, { accountId: "fixture-1", accessToken: "fixture-access-1" });
		expect(d.sendGreeting).toHaveBeenNthCalledWith(2, { accountId: "fixture-1", accessToken: "fixture-new-access" });
		expect(d.sendGreeting).toHaveBeenCalledTimes(4);
	});

	it.each(["refresh", "persist"])("continues when credential %s fails, without sending that account's greeting", async kind => {
		const storage = pool();
		storage.accounts[0]!.accessToken = undefined;
		const d = deps(kind === "refresh" ? { refresh: vi.fn(async () => ({ type: "failed", message: "fixture-refresh-1" })) } : { persistCredentials: vi.fn(async () => { throw new Error("fixture-new-access"); }) });
		const output = logs();
		expect(await runListHolaCommand(storage, output, d)).toBe(1);
		expect(d.sendGreeting).toHaveBeenCalledTimes(2);
		expect(output.logError.mock.calls.flat().join("\n")).not.toMatch(/fixture-(new-access|refresh-1)/);
	});

	it("uses the selected workspace instead of the account's default workspace", async () => {
		const storage = pool();
		storage.accounts[0]!.workspaces = [{ id: "fixture-personal", enabled: true }, { id: "fixture-work", enabled: true }];
		storage.accounts[0]!.currentWorkspaceIndex = 1;
		const d = deps();
		expect(await runListHolaCommand(storage, logs(), d)).toBe(0);
		expect(d.sendGreeting).toHaveBeenNthCalledWith(1, { accountId: "fixture-work", accessToken: "fixture-access-1" });
		expect(d.recordQuota).toHaveBeenNthCalledWith(1, storage.accounts[0], "fixture-work", expect.anything(), storage.accounts);
	});

	it("does not repeat a completed greeting when saving quota or usage fails", async () => {
		const d = deps({ appendUsage: vi.fn(async () => { throw new Error("busy"); }), recordQuota: vi.fn(async () => { throw new Error("busy"); }) });
		expect(await runListHolaCommand(pool(), logs(), d)).toBe(0);
		expect(d.sendGreeting).toHaveBeenCalledTimes(3);
	});

	it("cleans terminal controls and credentials out of responses and JSON", async () => {
		const d = deps({ sendGreeting: vi.fn(async () => ({ ...greeting(), text: "\x1b[2JHola\nfixture-access-1 fixture-refresh-1" })) });
		const output = logs(true);
		await runListHolaCommand(pool(), output, d);
		const first = JSON.parse(output.logInfo.mock.calls[0]![0]).results[0];
		expect(first.response).toBe("Hola [REDACTED] [REDACTED]");
	});

	it.each([null, { version: 3, activeIndex: 0, accounts: [] } as AccountStorageV3])("reports an empty pool as a failure without requests", async storage => {
		const d = deps();
		expect(await runListHolaCommand(storage, logs(true), d)).toBe(1);
		expect(d.sendGreeting).not.toHaveBeenCalled();
	});
});
