import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { startRuntimeRotationProxy, type RuntimeRotationProxyServer } from "../lib/runtime-rotation-proxy.js";
import type { QuotaCacheData } from "../lib/quota-cache.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

vi.mock("../lib/storage.js", async importOriginal => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return { ...actual, withAccountStorageTransaction: async (handler: (current: null, persist: () => Promise<void>) => Promise<void>) => handler(null, async () => undefined) };
});

let dir: string;
const proxies: RuntimeRotationProxyServer[] = [];
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "cma-sequential-proxy-"));
	vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
	vi.stubEnv("CODEX_AUTH_SCHEDULING_STRATEGY", "sequential");
	vi.stubEnv("CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT", "2");
	vi.stubEnv("CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT", "2");
	AccountManager.resetVolatileRuntimeState();
});
afterEach(async () => {
	for (const proxy of proxies.splice(0)) await proxy.close();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	await removeWithRetry(dir, { recursive: true, force: true });
});

async function start(activeIndex: number, handler: (accountId: string) => Response | Promise<Response>, options: Partial<Parameters<typeof startRuntimeRotationProxy>[0]> = {}) {
	const manager = new AccountManager(undefined, { version: 3, activeIndex, activeIndexByFamily: { codex: activeIndex }, accounts: [0, 1, 2].map(i => ({
		accountId: `fixture-${i}`, email: `account-${i}@example.test`, refreshToken: `refresh-${i}`, accessToken: `access-${i}`,
		expiresAt: Date.now() + 3_600_000, addedAt: 1, lastUsed: 1, enabled: true,
	})) });
	const proxy = await startRuntimeRotationProxy({ accountManager: manager, clientApiKey: "fixture-client", upstreamBaseUrl: "https://upstream.example.test",
		fetchImpl: async (_input, init) => handler(new Headers(init?.headers).get("chatgpt-account-id") ?? "unknown"),
		...options,
	});
	proxies.push(proxy);
	return proxy;
}
function success(headers: Record<string, string> = {}, event = ""): Response {
	return new Response(`${event}data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n`, { headers: { "content-type": "text/event-stream", ...headers } });
}
async function send(proxy: RuntimeRotationProxyServer, session: string) {
	const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: "Bearer fixture-client", "content-type": "application/json" },
		body: JSON.stringify({ model: "gpt-5-codex", stream: true, input: "fixture", metadata: { session_id: session } }),
	});
	const text = await response.text();
	expect(response.status, text).toBe(200);
}

it.each(["quota", "network"] as const)("shares one account across projects and propagates a %s fallback", async failure => {
	const calls: string[] = [];
	let failing = false;
	const handler = (id: string) => {
		calls.push(id);
		if (id === "fixture-1" && failing) {
			if (failure === "network") throw new Error("fixture network error");
			return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": "60" } });
		}
		return success();
	};
	const a = await start(1, handler), b = await start(0, handler);
	await send(a, "project-a");
	await send(b, "project-b");
	failing = true;
	await send(a, "project-a");
	await send(b, "project-b");
	expect(calls).toEqual(["fixture-1", "fixture-1", "fixture-1", "fixture-2", "fixture-2"]);
});

it.each([
	{ slot: "primary", windowMinutes: 300 }, { slot: "secondary", windowMinutes: 300 },
	{ slot: "primary", windowMinutes: 10080 }, { slot: "secondary", windowMinutes: 10080 },
])("keeps a lone $windowMinutes-minute $slot limit at three percent and rotates at two percent", async ({ slot, windowMinutes }) => {
	const calls: string[] = [];
	let used = 97;
	const handler = (id: string) => {
		calls.push(id);
		return success(id === "fixture-0" ? {
			[`x-codex-${slot}-used-percent`]: String(used),
			[`x-codex-${slot}-window-minutes`]: String(windowMinutes),
			[`x-codex-${slot}-reset-after-seconds`]: "3600",
		} : {});
	};
	const a = await start(0, handler), b = await start(2, handler);
	await send(a, "project-a");
	await send(a, "project-a");
	used = 98;
	await send(a, "project-a");
	await send(a, "project-a");
	await send(b, "project-b");
	expect(calls).toEqual(["fixture-0", "fixture-0", "fixture-0", "fixture-1", "fixture-1"]);
});

it("does not let a late response on the old account undo another project's rotation", async () => {
	let release!: () => void;
	let dispatched!: () => void;
	const started = new Promise<void>(resolve => { dispatched = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	const a = await start(0, async () => { dispatched(); await gate; return success(); });
	const first = send(a, "project-a");
	await started;
	const calls: string[] = [];
	const b = await start(0, id => {
		calls.push(id);
		return id === "fixture-0" ? Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 }) : success();
	});
	try { await send(b, "project-b"); } finally { release(); }
	await first;
	await send(b, "project-b");
	expect(calls).toEqual(["fixture-0", "fixture-1", "fixture-1"]);
});

it("uses a fresh weekly-only stream update instead of the depleted five-hour header", async () => {
	const calls: string[] = [];
	const handler = (id: string) => {
		calls.push(id);
		const event = `data: ${JSON.stringify({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 20, window_minutes: 10080, reset_at: Math.floor(Date.now() / 1000) + 3600 } } })}\n\n`;
		return success({ "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "3600" }, event);
	};
	const a = await start(0, handler);
	await send(a, "weekly-only");
	await send(a, "weekly-only");
	expect(calls).toEqual(["fixture-0", "fixture-0"]);
});

function datedQuotas(at: number): QuotaCacheData {
	return { byEmail: {}, byAccountId: Object.fromEntries([
		"2026-10-09T21:00:00Z", "2026-10-09T23:00:00Z", "2026-10-10T21:00:00Z",
	].map((reset, index) => [`fixture-${index}`, { status: 200, updatedAt: at, model: "fixture", primary: {}, secondary: { usedPercent: 10, windowMinutes: 10080, resetAtMs: Date.parse(reset) } }])) };
}

it("shares the earliest weekly cohort, drains it before later days and returns on recovery", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.parse("2026-10-06T20:00:00Z"));
	vi.stubEnv("TZ", "America/Bogota");
	const cache = datedQuotas(Date.now());
	const calls: string[] = [];
	const handler = (id: string) => { calls.push(id); return success(); };
	const options = { readSubscriptionQuota: async () => cache };
	const a = await start(2, handler, options), b = await start(2, handler, options);
	await send(a, "project-a");
	await send(b, "project-b");
	cache.byAccountId["fixture-0"]!.secondary.usedPercent = 98;
	vi.setSystemTime(Date.now() + 2000);
	await send(a, "project-a");
	cache.byAccountId["fixture-1"]!.primary = { usedPercent: 100, windowMinutes: 300, resetAtMs: Date.now() + 60_000 };
	vi.setSystemTime(Date.now() + 2000);
	await send(a, "project-a");
	await send(b, "project-b");
	vi.setSystemTime(Date.now() + 60_001);
	await send(a, "project-a");
	await send(b, "project-b");
	expect(calls).toEqual(["fixture-0", "fixture-0", "fixture-1", "fixture-2", "fixture-2", "fixture-1", "fixture-1"]);
});

it("shares an earlier cohort's upstream failure until its retry window expires", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.parse("2026-10-06T20:00:00Z"));
	const cache = datedQuotas(Date.now());
	cache.byAccountId["fixture-1"]!.secondary.resetAtMs = Date.parse("2026-10-10T20:00:00Z");
	let failing = true;
	const calls: string[] = [];
	const handler = (id: string) => { calls.push(id); return id === "fixture-0" && failing ? Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": "10" } }) : success(); };
	const a = await start(0, handler, { readSubscriptionQuota: async () => cache }), b = await start(0, handler, { readSubscriptionQuota: async () => cache });
	await send(a, "project-a");
	await send(b, "project-b");
	vi.setSystemTime(Date.now() + 11_000);
	failing = false;
	await send(b, "project-b");
	expect(calls).toEqual(["fixture-0", "fixture-1", "fixture-1", "fixture-0"]);
});

it("reclaims an earlier day when a newer weekly-only observation confirms quota recovery", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.parse("2026-10-06T20:00:00Z"));
	const cache = datedQuotas(Date.now());
	cache.byAccountId["fixture-1"]!.secondary.resetAtMs = Date.parse("2026-10-10T20:00:00Z");
	const calls: string[] = [];
	let depleted = true;
	const a = await start(0, id => {
		calls.push(id);
		return id === "fixture-0" && depleted ? success({ "x-codex-primary-used-percent": "98", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "3600", "x-codex-secondary-used-percent": "10", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": String(Date.parse("2026-10-09T21:00:00Z") / 1000) }) : success();
	}, { readSubscriptionQuota: async () => cache });
	await send(a, "project-a");
	await send(a, "project-a");
	vi.setSystemTime(Date.now() + 2000);
	cache.byAccountId["fixture-0"]!.updatedAt = Date.now();
	cache.byAccountId["fixture-0"]!.primary = {};
	depleted = false;
	await send(a, "project-a");
	expect(calls).toEqual(["fixture-0", "fixture-1", "fixture-0"]);
});
