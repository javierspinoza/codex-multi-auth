import { stripVTControlCharacters } from "node:util";
import { loadAccountPolicyStore, getAccountPolicyKey, type AccountPolicy } from "../../account-policy.js";
import type { QuotaCacheData, QuotaCacheEntry, QuotaCacheWindow } from "../../quota-cache.js";
import { findQuotaCacheEntryForAccount, isQuotaCacheEntryExhausted } from "../../quota-readiness.js";
import { inferenceAccountKey } from "../../runtime/inference-activity.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../../storage.js";
import { buildTableHeader, buildTableRow } from "../../table-formatter.js";
import { displayWidth } from "../../ui/display-width.js";
import { paintUiText, type UiTextTone } from "../../ui/format.js";
import { getUiRuntimeOptions } from "../../ui/runtime.js";
import { createUiTheme } from "../../ui/theme.js";
import { runStatusCommand, type StatusCommandDeps } from "./status.js";
import type { ListHolaOptions } from "../list-hola.js";

const USAGE = "Usage: codex-multi-auth list [--json | --verbose | --hola [--json]]";

export interface ListCommandDeps extends StatusCommandDeps {
	isRotationEnabled: () => boolean;
	getSchedulingStrategy?: () => "hybrid" | "sequential";
	loadSequentialPrimaryAccountKey?: () => Promise<string | null>;
	runHola: (storage: AccountStorageV3 | null, options: ListHolaOptions) => Promise<number>;
	refreshQuotaCache: (
		storage: AccountStorageV3,
		cache: QuotaCacheData,
		maxAgeMs: number,
	) => Promise<QuotaCacheData>;
	logError?: (message: string) => void;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function localReset(resetAtMs: number | undefined): string {
	if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs) || resetAtMs <= 0) return "—";
	const date = new Date(resetAtMs);
	if (!Number.isFinite(date.getTime())) return "—";
	return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localTimestamp(now: number): string {
	const date = new Date(now);
	const offset = -date.getTimezoneOffset();
	const zone = `${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`;
}

function localRequestTime(at: number | null): string {
	if (at === null) return "—";
	const date = new Date(at);
	return `${localReset(at)}:${pad(date.getSeconds())}`;
}

function validInferenceTime(at: number | undefined, now: number): number {
	return typeof at === "number" && Number.isFinite(at) && at > 0 && at <= now && Number.isFinite(new Date(at).getTime()) ? at : 0;
}

function activeWindow(window: QuotaCacheWindow, entry: QuotaCacheEntry, now: number): QuotaCacheWindow {
	const expiry = window.resetAtMs ?? (window.windowMinutes && window.windowMinutes > 0 ? entry.updatedAt + window.windowMinutes * 60_000 : null);
	return expiry !== null && now >= expiry ? {} : window;
}

function remaining(window: QuotaCacheWindow | undefined): number | null {
	const used = window?.usedPercent;
	return typeof used === "number" && Number.isFinite(used) ? Math.max(0, Math.min(100, 100 - used)) : null;
}

function percent(window: QuotaCacheWindow | undefined): string {
	const left = remaining(window);
	if (left === null) return "N/D";
	if (left > 0 && left < 0.1) return "<0.1%";
	return `${Number(left.toFixed(1))}%`;
}

function weeklyQuotaTone(left: number | null): UiTextTone {
	if (left === null || left === 0) return "normal";
	if (left >= 50) return "success";
	if (left >= 30) return "warning";
	return "danger";
}

function displayAccountValue(value: string | undefined, fallback = "—"): string {
	return value ? stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() || fallback : fallback;
}

function accountState(
	account: AccountMetadataV3,
	quota: QuotaCacheEntry | null,
	policy: Partial<AccountPolicy> | undefined,
	rateLimit: string | null,
	now: number,
): string {
	if (account.enabled === false) return "deshabilitada";
	if (account.authInvalidatedAt) return "iniciar sesión";
	if (account.workspaces?.length) {
		const workspace = account.workspaces[account.currentWorkspaceIndex ?? 0];
		if (!workspace || workspace.enabled === false) return "workspace no disponible";
	}
	if (policy?.paused) return "pausada";
	if (policy?.drained) return "excluida";
	if (isQuotaCacheEntryExhausted(quota, now)) {
		const exhausted = quota ? [quota.primary, quota.secondary].filter(window => remaining(activeWindow(window, quota, now)) === 0) : [];
		const labels = exhausted.map(window => window.windowMinutes === 300 ? "5h" : window.windowMinutes === 10080 ? "semanal" : "ventana");
		return `sin cuota ${[...new Set(labels)].join(" y ")}`;
	}
	if (rateLimit || quota?.status === 429) return "limitada";
	if ((account.coolingDownUntil ?? 0) > now) return "en espera";
	if (!quota || [quota.primary, quota.secondary].every(window => remaining(activeWindow(window, quota, now)) === null)) return "sin datos";
	return "ok";
}

/** Live quota table for people; status retains the detailed cached diagnostic view. */
export async function runListCommand(args: string[], deps: ListCommandDeps): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const allowed = new Set(["--json", "-j", "--verbose", "--hola", "--help", "-h"]);
	const unknown = args.find(arg => !allowed.has(arg));
	if (unknown) {
		logError(`Unknown list option: ${unknown}`);
		logError(USAGE);
		return 1;
	}
	if (args.includes("--help") || args.includes("-h")) {
		logInfo(USAGE);
		return 0;
	}
	const json = args.includes("--json") || args.includes("-j");
	const verbose = args.includes("--verbose");
	const hola = args.includes("--hola");
	if (hola && verbose) {
		logError("--hola no se puede combinar con --verbose.");
		logError(USAGE);
		return 1;
	}
	deps.setStoragePath(null);
	const storage = await deps.loadAccounts();
	if (hola) return deps.runHola(storage, { json, logInfo, logError });
	let quotaCache = await deps.loadQuotaCache?.() ?? { byAccountId: {}, byEmail: {} };
	if (storage?.accounts.length) {
		logError(`Consultando ${storage.accounts.length} cuenta(s)…`);
		quotaCache = await deps.refreshQuotaCache(storage, quotaCache, 0);
	}
	const resolvedDeps = { ...deps, loadAccounts: () => Promise.resolve(storage), loadQuotaCache: () => Promise.resolve(quotaCache), json };
	if (json || verbose || !storage?.accounts.length) return runStatusCommand(resolvedDeps);
	const activityKeys = storage.accounts.map(inferenceAccountKey);
	const strategy = deps.getSchedulingStrategy?.() ?? "hybrid";
	const [snapshotResult, activityResult, sharedPrimaryResult] = await Promise.allSettled([
		deps.loadRuntimeObservabilitySnapshot?.() ?? Promise.resolve(null),
		deps.loadInferenceRequestTimes?.(activityKeys) ?? Promise.resolve({}),
		strategy === "sequential" ? deps.loadSequentialPrimaryAccountKey?.() ?? Promise.resolve(null) : Promise.resolve(null),
	]);
	const snapshotTimes = snapshotResult.status === "fulfilled" ? snapshotResult.value?.lastInferenceRequestAtByAccount : undefined;
	const persistedTimes: Record<string, number> = activityResult.status === "fulfilled" ? activityResult.value : {};
	const now = deps.getNow?.() ?? Date.now();
	// Per-account files survive other proxies overwriting the shared snapshot.
	// Selection, lastUsed and quota probes are not evidence of inference traffic.
	const inferenceTimes = activityKeys.map(key => Math.max(
		validInferenceTime(snapshotTimes?.[key], now),
		validInferenceTime(persistedTimes[key], now),
	) || null);
	const timestamp = localTimestamp(now);
	const rotationEnabled = deps.isRotationEnabled();
	const ui = getUiRuntimeOptions();
	// Quota colors retain their meaning even when the user's general theme is blue.
	const quotaUi = { ...ui, theme: createUiTheme({ profile: ui.colorProfile, colorMode: ui.colorMode, palette: "green" }) };
	let policiesUnavailable = false;
	const policies: Awaited<ReturnType<typeof loadAccountPolicyStore>> = await (deps.loadAccountPolicies ?? loadAccountPolicyStore)({ strict: true }).catch(() => {
		policiesUnavailable = true;
		return { version: 1 as const, accounts: {} };
	});
	const extraWindows: string[] = [];
	const observations: number[] = [];
	const rows = storage.accounts.map((account, index) => {
		const quota = findQuotaCacheEntryForAccount(quotaCache, account, storage.accounts);
		if (quota) observations.push(quota.updatedAt);
		const windows = quota ? [quota.primary, quota.secondary].map(window => activeWindow(window, quota, now)) : [];
		// Window positions can change: classify by the service's duration, never assume primary = 5h.
		const fiveHours = windows.find(window => window.windowMinutes === 300);
		const weekly = windows.find(window => window.windowMinutes === 10080);
		for (const window of windows) {
			if (remaining(window) !== null && window.windowMinutes !== 300 && window.windowMinutes !== 10080) {
				extraWindows.push(`cuenta${index + 1}: ${typeof window.windowMinutes === "number" && window.windowMinutes > 0 ? `${window.windowMinutes} min` : "duración no informada"}, ${percent(window)} restante, reinicia ${localReset(window.resetAtMs)}`);
			}
		}
		const state = accountState(account, quota, policies.accounts[getAccountPolicyKey(account, index)], deps.formatRateLimitEntry(account, now, "codex"), now);
		const name = displayAccountValue(account.accountLabel || account.workspaces?.[account.currentWorkspaceIndex ?? 0]?.name);
		const email = displayAccountValue(account.email, "N/D");
		return {
			index,
			lastInferenceAt: inferenceTimes[index] ?? null,
			fiveHoursLeft: remaining(fiveHours) ?? -1,
			weeklyLeft: remaining(weekly),
			cells: [`cuenta${index + 1}`, name, email, displayAccountValue(quota?.planType?.toLowerCase(), "N/D"), percent(fiveHours), localReset(fiveHours?.resetAtMs), percent(weekly), localReset(weekly?.resetAtMs), state, localRequestTime(inferenceTimes[index] ?? null)],
		};
	});
	rows.sort((a, b) => b.fiveHoursLeft - a.fiveHoursLeft || (b.weeklyLeft ?? -1) - (a.weeklyLeft ?? -1) || a.index - b.index);
	const headers = ["CUENTA", "NOMBRE", "CORREO", "PLAN", "5 HORAS", "REINICIA", "SEMANAL", "REINICIA", "ESTADO", "ÚLTIMA SOLICITUD"];
	logInfo(`Cuota RESTANTE · consulta en vivo · reinicios en hora local · ${timestamp}`);
	const tableOptions = {
		columns: headers.map((header, index) => ({ header, width: Math.max(displayWidth(header), ...rows.map(row => displayWidth(row.cells[index] ?? ""))) })),
	};
	for (const line of buildTableHeader(tableOptions)) logInfo(line);
	for (const row of rows) {
		// Format the plain row before coloring so ANSI escapes cannot alter column widths.
		const line = buildTableRow(row.cells, tableOptions);
		logInfo(paintUiText(quotaUi, line, weeklyQuotaTone(row.weeklyLeft)));
	}
	const selected = deps.resolveActiveIndex(storage, "codex");
	const pin = storage.pinnedAccountIndex;
	const pinned = typeof pin === "number" && Number.isInteger(pin) && pin >= 0 && pin < storage.accounts.length ? pin : null;
	const rotationState = rotationEnabled ? pinned === null ? "activa" : "activa, cambio automático suspendido por fijación" : "inactiva";
	const showSharedPrimary = rotationEnabled && strategy === "sequential";
	logInfo(showSharedPrimary ? `Rotación: ${rotationState}` : `Rotación: ${rotationState} · cuenta seleccionada: cuenta${selected + 1} (guardada)`);
	if (showSharedPrimary) {
		const primaryKey = sharedPrimaryResult.status === "fulfilled" ? sharedPrimaryResult.value : null;
		const primaryIndex = primaryKey ? activityKeys.indexOf(primaryKey) : -1;
		logInfo(`Estrategia: secuencial · cuenta compartida: ${pinned !== null ? `cuenta${pinned + 1} (fijada)` : primaryIndex >= 0 ? `cuenta${primaryIndex + 1}` : "se define en la próxima solicitud"}`);
		if (pinned === null) logInfo("Prioridad: día de reinicio semanal más próximo; mantiene la cuenta dentro del mismo día y vuelve a días anteriores si recuperan cuota.");
	}
	const latestInferenceAt = Math.max(...inferenceTimes.map(at => at ?? 0));
	if (latestInferenceAt > 0) {
		const latestAccounts = rows.filter(row => row.lastInferenceAt === latestInferenceAt).sort((a, b) => a.index - b.index).map(row => `cuenta${row.index + 1}`);
		logInfo(`Última solicitud enviada: ${latestAccounts.join(", ")} · ${localTimestamp(latestInferenceAt)}`);
	} else {
		logInfo("Última solicitud enviada: sin actividad de inferencia registrada por el proxy.");
	}
	if (snapshotResult.status === "rejected" || activityResult.status === "rejected") logInfo("No se pudo leer parte del registro de actividad del proxy.");
	logInfo("ÚLTIMA SOLICITUD: envío de chat o imagen por el proxy; — = sin registro. No incluye consultas de cuota ni confirma una solicitud en curso.");
	logInfo(strategy === "sequential" ? "Los proyectos que comparten el pool siguen la cuenta compartida con prioridad a la renovación semanal más próxima; el registro no identifica cada chat." : "Los chats pueden usar cuentas distintas con rotación; este registro muestra actividad por cuenta, sin identificar cada chat.");
	if (pinned !== null) logInfo(`Cuenta fijada: cuenta${pinned + 1} · quitar fijación: codex-multi-auth unpin`);
	if (!rotationEnabled) logInfo("Activar rotación: codex-multi-auth rotation enable");
	logInfo("N/D: el servicio no devolvió ese dato o no se pudo consultar. No equivale a 0% ni confirma ausencia de límite.");
	if (observations.length) {
		const oldest = Math.min(...observations);
		logInfo(`Datos consultados desde: ${localTimestamp(oldest)}`);
	}
	for (const window of extraWindows) logInfo(`Otra ventana: ${window}`);
	if (policiesUnavailable) logInfo("Políticas de cuentas no disponibles; comprueba codex-multi-auth doctor.");
	const apiRoutes = await deps.loadApiRoutes?.().catch(() => {
		logInfo("No se pudo consultar la configuración API.");
		return [];
	}) ?? [];
	if (apiRoutes.length) {
		logInfo("Credenciales API/ZDR (sin cuotas de suscripción):");
		for (const route of apiRoutes) logInfo(`${route.label.replace(/[\u0000-\u001f\u007f]/g, "")} · ${route.kind.toUpperCase()} · ${route.visibleModels.length} modelos · ${route.enabled ? "habilitada" : "deshabilitada"}`);
	}
	logInfo(`Ejecutado en hora local: ${timestamp}`);
	return 0;
}
