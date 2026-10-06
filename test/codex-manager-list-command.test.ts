import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runListCommand, type ListCommandDeps } from "../lib/codex-manager/commands/list.js";
import type { QuotaCacheEntry } from "../lib/quota-cache.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { inferenceAccountKey } from "../lib/runtime/inference-activity.js";
import { getRuntimeObservabilitySnapshot } from "../lib/runtime/runtime-observability.js";
import { resetUiRuntimeOptions, setUiRuntimeOptions } from "../lib/ui/runtime.js";

const now = Date.parse("2026-10-06T15:57:33Z");
const reset5h = Date.parse("2026-10-06T18:15:00Z");
const resetWeekly = Date.parse("2026-10-10T14:01:00Z");

function quota(primary: QuotaCacheEntry["primary"], secondary: QuotaCacheEntry["secondary"]): QuotaCacheEntry {
	return { updatedAt: now, status: 200, model: "fixture", planType: "plus", primary, secondary };
}

function storage(): AccountStorageV3 {
	return {
		version: 3, activeIndex: 0, activeIndexByFamily: { codex: 0 },
		accounts: [
			{ accountId: "fixture-one", accountLabel: "Personal", email: "one@example.test", refreshToken: "fixture-refresh-one", addedAt: 1, lastUsed: 1, enabled: true },
			{ accountId: "fixture-two", accountLabel: "Trabajo", email: "two@example.test", refreshToken: "fixture-refresh-two", addedAt: 2, lastUsed: 2, enabled: true },
		],
	};
}

function deps(entries: Record<string, QuotaCacheEntry> = {}, overrides: Partial<ListCommandDeps> = {}): ListCommandDeps {
	return {
		setStoragePath: vi.fn(), getStoragePath: () => "/tmp/fixture-pool.json",
		loadAccounts: vi.fn(async () => storage()), resolveActiveIndex: () => 0,
		formatRateLimitEntry: () => null, getNow: () => now,
		loadQuotaCache: vi.fn(async () => ({ byAccountId: {}, byEmail: {} })),
		refreshQuotaCache: vi.fn(async () => ({ byAccountId: entries, byEmail: {} })),
		loadAccountPolicies: async () => ({ version: 1, accounts: {} }),
		isRotationEnabled: () => true,
		runHola: vi.fn(async () => 0),
		logInfo: vi.fn(), logError: vi.fn(), ...overrides,
	};
}

function output(d: ListCommandDeps): string {
	return vi.mocked(d.logInfo!).mock.calls.flat().join("\n");
}

describe("compact account list", () => {
	it("routes --hola directly without extra quota probes, preserving the greeting exit code", async () => {
		const s = storage();
		const d = deps({}, { loadAccounts: async () => s, runHola: vi.fn(async () => 1) });
		expect(await runListCommand(["--hola", "--json"], d)).toBe(1);
		expect(d.runHola).toHaveBeenCalledWith(s, { json: true, logInfo: d.logInfo, logError: d.logError });
		expect(d.refreshQuotaCache).not.toHaveBeenCalled();
		expect(d.loadQuotaCache).not.toHaveBeenCalled();
		expect(d.setStoragePath).toHaveBeenCalledWith(null);
	});

	it("does not send greetings for help, ordinary list or conflicting options", async () => {
		const d = deps();
		expect(await runListCommand(["--hola", "--help"], d)).toBe(0);
		expect(await runListCommand(["--hola", "--verbose"], d)).toBe(1);
		expect(d.loadAccounts).not.toHaveBeenCalled();
		expect(await runListCommand([], d)).toBe(0);
		expect(d.runHola).not.toHaveBeenCalled();
	});

	beforeEach(() => {
		vi.stubEnv("TZ", "America/Bogota");
		vi.stubEnv("FORCE_COLOR", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		resetUiRuntimeOptions();
	});

	it("shows account names, emails, remaining quota and local resets with stable numbers", async () => {
		const d = deps({
			"fixture-one": quota({ usedPercent: 100, windowMinutes: 300, resetAtMs: reset5h }, { usedPercent: 51, windowMinutes: 10080, resetAtMs: resetWeekly }),
			"fixture-two": quota({ usedPercent: 0, windowMinutes: 300, resetAtMs: reset5h }, { usedPercent: 36, windowMinutes: 10080, resetAtMs: resetWeekly }),
		});
		expect(await runListCommand([], d)).toBe(0);
		const text = output(d);
		expect(text).toContain("2026-10-06 10:57:33 -05:00");
		expect(text).toMatch(/CUENTA\s+NOMBRE\s+CORREO\s+PLAN\s+5 HORAS\s+REINICIA\s+SEMANAL\s+REINICIA\s+ESTADO/);
		expect(text).toMatch(/cuenta2\s+Trabajo\s+two@example.test\s+plus\s+100%\s+06\/10 13:15\s+64%\s+10\/10 09:01\s+ok/);
		expect(text).toMatch(/cuenta1\s+Personal\s+one@example.test\s+plus\s+0%\s+06\/10 13:15\s+49%\s+10\/10 09:01\s+sin cuota 5h/);
		expect(text.indexOf("cuenta2")).toBeLessThan(text.indexOf("cuenta1"));
		expect(text).toContain("Rotación: activa · cuenta seleccionada: cuenta1");
		expect(text).not.toContain("forecast risk");
		expect(d.setStoragePath).toHaveBeenCalledWith(null);
	});

	it("sorts 98% before 97% of five-hour quota regardless of account state", async () => {
		const s = storage();
		s.accounts[1]!.enabled = false;
		const d = deps({
			"fixture-one": quota({ usedPercent: 3, windowMinutes: 300, resetAtMs: reset5h }, { usedPercent: 0, windowMinutes: 10080, resetAtMs: resetWeekly }),
			"fixture-two": quota({ usedPercent: 2, windowMinutes: 300, resetAtMs: reset5h }, { usedPercent: 99, windowMinutes: 10080, resetAtMs: resetWeekly }),
		}, { loadAccounts: async () => s });
		await runListCommand([], d);
		const text = output(d);
		expect(text.indexOf("cuenta2")).toBeLessThan(text.indexOf("cuenta1"));
		expect(text).toMatch(/cuenta2.*98%.*1%.*deshabilitada/);
		expect(text).toMatch(/cuenta1.*97%.*100%.*ok/);
	});

	it("places unknown five-hour quota after known values and uses weekly quota for ties", async () => {
		const d = deps({
			"fixture-one": quota({}, { usedPercent: 0, windowMinutes: 10080, resetAtMs: resetWeekly }),
			"fixture-two": quota({ usedPercent: 100, windowMinutes: 300, resetAtMs: reset5h }, { usedPercent: 70, windowMinutes: 10080, resetAtMs: resetWeekly }),
		});
		await runListCommand([], d);
		expect(output(d).indexOf("cuenta2")).toBeLessThan(output(d).indexOf("cuenta1"));
		vi.mocked(d.logInfo!).mockClear();
		d.refreshQuotaCache = async () => ({ byAccountId: {
			"fixture-one": quota({ usedPercent: 2, windowMinutes: 300, resetAtMs: reset5h }, { usedPercent: 20, windowMinutes: 10080, resetAtMs: resetWeekly }),
			"fixture-two": quota({ usedPercent: 2, windowMinutes: 300, resetAtMs: reset5h }, { usedPercent: 10, windowMinutes: 10080, resetAtMs: resetWeekly }),
		}, byEmail: {} });
		await runListCommand([], d);
		expect(output(d).indexOf("cuenta2")).toBeLessThan(output(d).indexOf("cuenta1"));
	});

	it("shows the selected account and activation command when rotation is disabled", async () => {
		const d = deps({}, { isRotationEnabled: () => false, resolveActiveIndex: () => 1 });
		await runListCommand([], d);
		expect(output(d)).toContain("Rotación: inactiva · cuenta seleccionada: cuenta2");
		expect(output(d)).toContain("Activar rotación: codex-multi-auth rotation enable");
		expect(output(d)).not.toContain("rotación sin cuenta fijada");
	});

	it("shows the shared sequential primary without presenting the saved pointer as another selection", async () => {
		const key = inferenceAccountKey(storage().accounts[1]!);
		const d = deps({}, { getSchedulingStrategy: () => "sequential", loadSequentialPrimaryAccountKey: async () => key });
		await runListCommand([], d);
		expect(output(d)).toContain("Rotación: activa\nEstrategia: secuencial · cuenta compartida: cuenta2");
		expect(output(d)).not.toContain("cuenta seleccionada:");
		expect(output(d)).toContain("Estrategia: secuencial · cuenta compartida: cuenta2");
		expect(output(d)).toContain("Los proyectos que comparten el pool siguen la cuenta compartida");
		expect(output(d)).not.toContain("Los chats pueden usar cuentas distintas");
	});

	it("distinguishes stored selection from inference across proxies and preserves quota sorting", async () => {
		const s = storage();
		const keys = s.accounts.map(inferenceAccountKey);
		const snapshot = getRuntimeObservabilitySnapshot();
		snapshot.lastAccountIndex = 0; // A later catalog/diagnostic selection is not inference.
		snapshot.lastAccountUpdatedAt = now;
		snapshot.lastInferenceRequestAtByAccount = { [keys[0]!]: now - 120_000, [keys[1]!]: now - 90_000 };
		const d = deps({
			"fixture-one": quota({ usedPercent: 0, windowMinutes: 300 }, {}),
			"fixture-two": quota({ usedPercent: 10, windowMinutes: 300 }, {}),
		}, {
			loadAccounts: async () => s,
			loadRuntimeObservabilitySnapshot: async () => snapshot,
			loadInferenceRequestTimes: vi.fn(async () => ({ [keys[0]!]: now - 180_000, [keys[1]!]: now - 15_000 })),
		});
		await runListCommand([], d);
		const text = output(d);
		expect(text).toContain("cuenta seleccionada: cuenta1 (guardada)");
		expect(text).toContain("Última solicitud enviada: cuenta2 · 2026-10-06 10:57:18 -05:00");
		expect(text).toMatch(/cuenta1\s+Personal.*06\/10 10:55:33/);
		expect(text).toMatch(/cuenta2\s+Trabajo.*06\/10 10:57:18/);
		expect(text.indexOf("cuenta1")).toBeLessThan(text.indexOf("cuenta2"));
		expect(d.loadInferenceRequestTimes).toHaveBeenCalledWith(keys);
		expect(text).toContain("sin identificar cada chat");
		vi.mocked(d.logInfo!).mockClear();
		await runListCommand(["--json"], d);
		expect(d.logInfo).toHaveBeenCalledTimes(1);
		const json = JSON.parse(output(d));
		expect(json.accounts[0].lastInferenceRequestAt).toBe(now - 120_000);
		expect(json.accounts[1].lastInferenceRequestAt).toBe(now - 15_000);
	});

	it("does not infer chat activity from lastUsed, quota probes or runtime selection", async () => {
		const s = storage();
		s.accounts[0]!.lastUsed = now;
		const snapshot = getRuntimeObservabilitySnapshot();
		snapshot.lastAccountIndex = 1;
		snapshot.lastAccountUpdatedAt = now;
		snapshot.lastInferenceRequestAtByAccount = {};
		const d = deps({}, { loadAccounts: async () => s, loadRuntimeObservabilitySnapshot: async () => snapshot });
		await runListCommand([], d);
		expect(output(d)).toContain("ÚLTIMA SOLICITUD");
		expect(output(d)).toContain("Última solicitud enviada: sin actividad de inferencia registrada por el proxy.");
		expect(output(d)).toContain("No incluye consultas de cuota ni confirma una solicitud en curso.");
	});

	it("matches activity by account identity after the pool is reordered", async () => {
		const s = storage();
		const usedKey = inferenceAccountKey(s.accounts[1]!);
		s.accounts.reverse();
		const d = deps({}, { loadAccounts: async () => s, loadInferenceRequestTimes: async () => ({ [usedKey]: now }) });
		await runListCommand([], d);
		expect(output(d)).toMatch(/cuenta1\s+Trabajo.*06\/10 10:57:33/);
		expect(output(d)).toContain("Última solicitud enviada: cuenta1 · 2026-10-06 10:57:33 -05:00");
	});

	it("reports equal dispatch times without claiming one account was used later", async () => {
		const keys = storage().accounts.map(inferenceAccountKey);
		const d = deps({}, { loadInferenceRequestTimes: async () => Object.fromEntries(keys.map(key => [key, now])) });
		await runListCommand([], d);
		expect(output(d)).toContain("Última solicitud enviada: cuenta1, cuenta2 · 2026-10-06 10:57:33 -05:00");
	});

	it.each([0, -1, NaN, Infinity, now + 1])("ignores invalid inference times (%s)", async at => {
		const key = inferenceAccountKey(storage().accounts[0]!);
		const d = deps({}, { loadInferenceRequestTimes: async () => ({ [key]: at }) });
		await runListCommand([], d);
		expect(output(d)).toContain("Última solicitud enviada: sin actividad de inferencia registrada por el proxy.");
	});

	it.each(["snapshot", "files"] as const)("keeps the list available when activity %s cannot be read", async unavailable => {
		const key = inferenceAccountKey(storage().accounts[1]!);
		const snapshot = getRuntimeObservabilitySnapshot();
		snapshot.lastInferenceRequestAtByAccount = { [key]: now };
		const d = deps({}, {
			loadRuntimeObservabilitySnapshot: async () => { if (unavailable === "snapshot") throw new Error("fixture read failure"); return snapshot; },
			loadInferenceRequestTimes: async () => { if (unavailable === "files") throw new Error("fixture read failure"); return { [key]: now }; },
		});
		expect(await runListCommand([], d)).toBe(0);
		expect(output(d)).toContain("Última solicitud enviada: cuenta2");
		expect(output(d)).toContain("No se pudo leer parte del registro de actividad del proxy.");
	});

	it("uses workspace names or placeholders and removes terminal controls from identity columns", async () => {
		const s = storage();
		s.accounts[0]!.accountLabel = "\x1b[31mPersonal\x1b[0m\n";
		s.accounts[0]!.email = "\x1b[2Jone@example.test\r";
		s.accounts[1]!.accountLabel = undefined;
		s.accounts[1]!.email = undefined;
		s.accounts[1]!.workspaces = [{ id: "fixture-workspace", name: "Equipo", enabled: true }];
		const d = deps({}, { loadAccounts: async () => s });
		await runListCommand([], d);
		expect(output(d)).toMatch(/cuenta1\s+Personal\s+one@example.test/);
		expect(output(d)).toMatch(/cuenta2\s+Equipo\s+N\/D/);
		expect(output(d)).not.toContain("\x1b");
	});

	it.each([
		[100, "\x1b[92m"], [50, "\x1b[92m"], [49.9, "\x1b[93m"],
		[30, "\x1b[93m"], [29.9, "\x1b[91m"], [1, "\x1b[91m"],
		[0.4, "\x1b[91m"], [0, ""], [null, ""],
	] as const)("colors the entire row for %s%% weekly quota and keeps table alignment", async (left, color) => {
		vi.stubEnv("FORCE_COLOR", "1");
		setUiRuntimeOptions({ colorProfile: "ansi16", palette: "blue", colorMode: "dark" });
		const d = deps({ "fixture-one": quota(
			{ usedPercent: 2, windowMinutes: 300, resetAtMs: reset5h },
			left === null ? {} : { usedPercent: 100 - left, windowMinutes: 10080, resetAtMs: resetWeekly },
		) });
		await runListCommand([], d);
		const colored = output(d);
		const row = colored.split("\n").find(line => stripVTControlCharacters(line).startsWith("cuenta1"))!;
		if (color) {
			expect(row).toBe(`${color}${stripVTControlCharacters(row)}\x1b[0m`);
			expect(row).toContain(`${left}%`);
		}
		else expect(row).not.toContain("\x1b");
		vi.mocked(d.logInfo!).mockClear();
		vi.stubEnv("FORCE_COLOR", "0");
		await runListCommand([], d);
		expect(stripVTControlCharacters(colored)).toBe(output(d));
	});

	it("honors NO_COLOR and keeps forced-color JSON free of ANSI escapes", async () => {
		vi.stubEnv("FORCE_COLOR", "");
		vi.stubEnv("NO_COLOR", "1");
		const d = deps({ "fixture-one": quota({}, { usedPercent: 10, windowMinutes: 10080, resetAtMs: resetWeekly }) });
		await runListCommand([], d);
		expect(output(d)).not.toContain("\x1b");
		vi.mocked(d.logInfo!).mockClear();
		vi.stubEnv("FORCE_COLOR", "1");
		setUiRuntimeOptions({});
		await runListCommand(["--json"], d);
		expect(output(d)).not.toContain("\x1b");
		expect(JSON.parse(output(d)).accounts).toHaveLength(2);
	});

	it.each(["primary", "secondary"] as const)("recognizes a weekly-only %s window without inventing a 5h quota", async key => {
		const weekly = { usedPercent: 10, windowMinutes: 10080, resetAtMs: resetWeekly };
		const d = deps({ "fixture-one": quota(key === "primary" ? weekly : {}, key === "secondary" ? weekly : {}) });
		await runListCommand([], d);
		expect(output(d)).toMatch(/cuenta1\s+Personal\s+one@example.test\s+plus\s+N\/D\s+—\s+90%\s+10\/10 09:01\s+ok/);
		expect(output(d)).toContain("No equivale a 0% ni confirma ausencia de límite");
	});

	it("uses duration rather than slot order and reports weekly exhaustion", async () => {
		const d = deps({ "fixture-one": quota({ usedPercent: 100, windowMinutes: 10080, resetAtMs: resetWeekly }, { usedPercent: 20, windowMinutes: 300, resetAtMs: reset5h }) });
		await runListCommand([], d);
		expect(output(d)).toMatch(/cuenta1\s+Personal\s+one@example.test\s+plus\s+80%\s+06\/10 13:15\s+0%\s+10\/10 09:01\s+sin cuota semanal/);
	});

	it("keeps unknown durations visible without guessing that primary is a five-hour window", async () => {
		const d = deps({ "fixture-one": quota({ usedPercent: 10, resetAtMs: resetWeekly }, {}) });
		await runListCommand([], d);
		expect(output(d)).toMatch(/cuenta1\s+Personal\s+one@example.test\s+plus\s+N\/D\s+—\s+N\/D\s+—\s+ok/);
		expect(output(d)).toContain("Otra ventana: cuenta1: duración no informada, 90% restante, reinicia 10/10 09:01");
	});

	it("shows expired observations as unknown, rather than inventing full quota after a reset", async () => {
		const d = deps({ "fixture-one": quota({ usedPercent: 100, windowMinutes: 300, resetAtMs: now - 1 }, {}) });
		await runListCommand([], d);
		expect(output(d)).toMatch(/cuenta1\s+Personal\s+one@example.test\s+plus\s+N\/D\s+—\s+N\/D\s+—\s+sin datos/);
		expect(output(d)).not.toContain("sin cuota");
	});

	it("does not round remaining fractional quota down to zero or mark it exhausted", async () => {
		const d = deps({ "fixture-one": quota({ usedPercent: 99.6, windowMinutes: 300, resetAtMs: reset5h }, {}) });
		await runListCommand([], d);
		expect(output(d)).toMatch(/cuenta1\s+Personal\s+one@example.test\s+plus\s+0.4%\s+06\/10 13:15\s+N\/D\s+—\s+ok/);
	});

	it("shows unavailable accounts and a manual pin even when quota is present", async () => {
		const s = storage();
		s.pinnedAccountIndex = 1;
		s.accounts[1]!.enabled = false;
		const d = deps({}, { loadAccounts: async () => s });
		await runListCommand([], d);
		expect(output(d)).toContain("deshabilitada");
		expect(output(d)).toContain("Rotación: activa, cambio automático suspendido por fijación");
		expect(output(d)).toContain("Cuenta fijada: cuenta2 · quitar fijación: codex-multi-auth unpin");
	});

	it("probes on every list call, including when the saved observation is recent", async () => {
		const fresh = { byAccountId: { "fixture-one": quota({}, { usedPercent: 10, windowMinutes: 10080, resetAtMs: resetWeekly }) }, byEmail: {} };
		const refreshQuotaCache = vi.fn(async () => fresh);
		const d = deps({}, { loadQuotaCache: async () => ({ byAccountId: { "fixture-one": quota({ usedPercent: 90, windowMinutes: 300, resetAtMs: reset5h }, {}) }, byEmail: {} }), refreshQuotaCache });
		await runListCommand([], d);
		await runListCommand([], d);
		expect(refreshQuotaCache).toHaveBeenCalledTimes(2);
		expect(refreshQuotaCache).toHaveBeenCalledWith(expect.objectContaining({ accounts: expect.any(Array) }), expect.objectContaining({ byAccountId: expect.objectContaining({ "fixture-one": expect.any(Object) }) }), 0);
		expect(d.logError).toHaveBeenCalledWith("Consultando 2 cuenta(s)…");
		expect(output(d)).toMatch(/cuenta1\s+Personal\s+one@example.test\s+plus\s+N\/D\s+—\s+90%/);
		expect(output(d)).not.toContain("10%    06/10 13:15");
	});

	it("shows unknown quota after a failed live probe instead of a saved percentage", async () => {
		const saved = quota({ usedPercent: 4, windowMinutes: 300, resetAtMs: reset5h }, { usedPercent: 40, windowMinutes: 10080, resetAtMs: resetWeekly });
		const d = deps({}, {
			loadQuotaCache: async () => ({ byAccountId: { "fixture-one": saved }, byEmail: {} }),
			refreshQuotaCache: async () => ({ byAccountId: {}, byEmail: {} }),
		});
		await runListCommand([], d);
		expect(output(d)).toMatch(/cuenta1\s+Personal\s+one@example.test\s+N\/D\s+N\/D\s+—\s+N\/D\s+—\s+sin datos/);
		expect(output(d)).not.toContain("96%");
		expect(output(d)).not.toContain("60%");
		expect(output(d)).not.toContain("Datos consultados desde:");
	});

	it("rejects the removed refresh option before reading accounts", async () => {
		const d = deps();
		expect(await runListCommand(["--refresh"], d)).toBe(1);
		expect(d.loadAccounts).not.toHaveBeenCalled();
		expect(d.logError).toHaveBeenCalledWith("Unknown list option: --refresh");
	});

	it("preserves the status JSON contract without leaking text progress to stdout", async () => {
		const d = deps();
		await runListCommand(["--json"], d);
		expect(d.logInfo).toHaveBeenCalledTimes(1);
		const json = JSON.parse(output(d));
		expect(json).toMatchObject({ accountCount: 2, activeIndex: 0, pinnedAccountIndex: null });
		expect(json.accounts).toHaveLength(2);
	});

	it("rejects unsupported options before loading accounts", async () => {
		const d = deps();
		expect(await runListCommand(["--unknown"], d)).toBe(1);
		expect(d.loadAccounts).not.toHaveBeenCalled();
	});
});
