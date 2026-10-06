import { stripVTControlCharacters } from "node:util";
import { extractAccountEmail, extractAccountId, sanitizeEmail, codexCliAccountIdFor } from "../auth/token-utils.js";
import { loadQuotaCache, saveQuotaCache } from "../quota-cache.js";
import { queuedRefresh } from "../refresh-queue.js";
import {
	ACCOUNT_GREETING_MODEL, ACCOUNT_GREETING_PROMPT, AccountGreetingError,
	sendAccountGreeting, type AccountGreetingResult,
} from "../runtime/account-greeting.js";
import { inferenceAccountKey, saveInferenceRequestTime } from "../runtime/inference-activity.js";
import {
	findMatchingAccountIndex, getStoragePath, recordPendingAuth, withAccountStorageTransaction,
	type AccountMetadataV3, type AccountStorageV3,
} from "../storage.js";
import type { TokenResult, TokenSuccess } from "../types.js";
import { paintUiText } from "../ui/format.js";
import { getUiRuntimeOptions } from "../ui/runtime.js";
import { appendUsageLedgerRow } from "../usage/ledger.js";
import type { UsageLedgerAppendInput } from "../usage/types.js";
import { applyTokenAccountIdentity, hasUsableAccessToken } from "./account-credentials.js";
import { cloneQuotaCacheData, updateQuotaCacheForWorkspace } from "./quota-cache-helpers.js";

export interface ListHolaOptions {
	json?: boolean;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

export interface ListHolaDeps {
	refresh: (refreshToken: string) => Promise<TokenResult>;
	persistCredentials: (account: AccountMetadataV3, result: TokenSuccess) => Promise<AccountMetadataV3>;
	sendGreeting: typeof sendAccountGreeting;
	appendUsage: (row: UsageLedgerAppendInput) => Promise<unknown>;
	recordActivity: (account: AccountMetadataV3, at: number) => Promise<void>;
	recordQuota: (account: AccountMetadataV3, workspaceId: string, result: AccountGreetingResult, accounts: AccountMetadataV3[]) => Promise<void>;
	now: () => number;
}

/** Persist only credentials against the latest pool, preserving selection and concurrent edits. */
export async function persistGreetingCredentials(account: AccountMetadataV3, result: TokenSuccess): Promise<AccountMetadataV3> {
	await recordPendingAuth(getStoragePath(), {
		priorRefreshToken: account.refreshToken, recordId: account.recordId,
		refreshToken: result.refresh, accessToken: result.access, expiresAt: result.expires, at: Date.now(),
	});
	return withAccountStorageTransaction(async (current, persist) => {
		const index = current ? account.recordId
			? current.accounts.findIndex(row => row.recordId === account.recordId)
			: findMatchingAccountIndex(current.accounts, account, { allowUniqueAccountIdFallbackWithoutEmail: true }) : undefined;
		const target = index === undefined ? undefined : current?.accounts[index];
		if (!current || !target) throw new Error("Account was removed during credential renewal");
		if (target.refreshToken !== account.refreshToken && target.refreshToken !== result.refresh) {
			if (hasUsableAccessToken(target, Date.now())) return target;
			throw new Error("Account credentials changed during renewal");
		}
		target.refreshToken = result.refresh;
		target.accessToken = result.access;
		target.expiresAt = result.expires;
		applyTokenAccountIdentity(target, extractAccountId(result.access));
		const email = sanitizeEmail(extractAccountEmail(result.access, result.idToken));
		if (email) target.email = email;
		delete target.authInvalidatedAt;
		delete target.authInvalidationErrorCode;
		await persist(current);
		return target;
	});
}

const defaultDeps: ListHolaDeps = {
	refresh: queuedRefresh,
	persistCredentials: persistGreetingCredentials,
	sendGreeting: sendAccountGreeting,
	appendUsage: appendUsageLedgerRow,
	recordActivity: (account, at) => saveInferenceRequestTime(inferenceAccountKey(account), at),
	recordQuota: async (account, workspaceId, result, accounts) => {
		if (!result.quota) return;
		const cache = await loadQuotaCache();
		const baseline = cloneQuotaCacheData(cache);
		updateQuotaCacheForWorkspace(cache, account, workspaceId, result.quota, accounts);
		await saveQuotaCache(cache, baseline);
	},
	now: Date.now,
};

function cleanText(value: string, account?: AccountMetadataV3): string {
	let text = value;
	for (const token of [account?.accessToken, account?.refreshToken]) {
		if (token) text = text.split(token).join("[REDACTED]");
	}
	return stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

/** Explicit sequential inference on every saved OAuth account, independently of routing pins. */
export async function runListHolaCommand(
	storage: AccountStorageV3 | null,
	options: ListHolaOptions = {},
	deps: ListHolaDeps = defaultDeps,
): Promise<number> {
	const logInfo = options.logInfo ?? console.log;
	const logError = options.logError ?? console.error;
	const ui = getUiRuntimeOptions();
	const accounts = storage?.accounts ?? [];
	const results: Array<{ account: number; name: string; status: "ok" | "error"; response?: string; responseId?: string; error?: string }> = [];
	if (!options.json) logInfo(`Enviando "${ACCOUNT_GREETING_PROMPT}" con GPT-6 Luna (${ACCOUNT_GREETING_MODEL}) a ${accounts.length} cuenta(s), en orden.`);
	for (let index = 0; index < accounts.length; index++) {
		const source = accounts[index];
		if (!source) continue;
		let account = source;
		let dispatched = false;
		let startedAt = deps.now();
		let workspaceId: string | undefined;
		let result: AccountGreetingResult | undefined;
		let failure: AccountGreetingError | undefined;
		const name = cleanText(source.accountLabel || source.email || `cuenta${index + 1}`, source);
		logError(`cuenta${index + 1}/${accounts.length} · ${name} · enviando hola…`);
		const renew = async () => {
			const refreshed = await deps.refresh(account.refreshToken);
			if (refreshed.type !== "success") throw new AccountGreetingError("No se pudieron renovar las credenciales; ejecuta codex-multi-auth login.", "refresh_failed", refreshed.statusCode);
			try { account = await deps.persistCredentials(account, refreshed); }
			catch { throw new AccountGreetingError("No se pudieron guardar las credenciales renovadas; el saludo no se envió.", "credential_save_failed"); }
		};
		try {
			if (!hasUsableAccessToken(account, deps.now())) await renew();
			const resolveWorkspace = () => {
				const workspace = account.workspaces?.length ? account.workspaces[account.currentWorkspaceIndex ?? 0] : undefined;
				if (account.workspaces?.length && (!workspace || workspace.enabled === false)) throw new AccountGreetingError("El workspace seleccionado no está disponible.", "workspace_unavailable");
				const identity = { accountId: workspace?.id ?? account.accountId, codexCliMirror: account.codexCliMirror };
				return codexCliAccountIdFor(identity, account.accessToken);
			};
			workspaceId = resolveWorkspace();
			if (!workspaceId || !account.accessToken) throw new AccountGreetingError("La cuenta no tiene una identidad válida para Codex.", "missing_identity");
			startedAt = deps.now();
			await deps.recordActivity(account, startedAt).catch(() => logError(`cuenta${index + 1}: no se pudo guardar la hora de actividad.`));
			dispatched = true;
			try { result = await deps.sendGreeting({ accountId: workspaceId, accessToken: account.accessToken }); }
			catch (error) {
				// A rejected 401 has not accepted the turn. Renew once; never retry an accepted stream.
				if (!(error instanceof AccountGreetingError) || error.statusCode !== 401) throw error;
				await renew();
				workspaceId = resolveWorkspace();
				if (!workspaceId || !account.accessToken) throw new AccountGreetingError("La cuenta no tiene una identidad válida para Codex.", "missing_identity");
				result = await deps.sendGreeting({ accountId: workspaceId, accessToken: account.accessToken });
			}
			const response = cleanText(result.text, account);
			results.push({ account: index + 1, name, status: "ok", response, responseId: result.responseId });
			if (!options.json) logInfo(`cuenta${index + 1} · ${name}: ${response}`);
			await deps.recordQuota(account, workspaceId, result, accounts).catch(() => logError(`cuenta${index + 1}: el saludo se completó, pero no se pudo guardar la cuota.`));
		} catch (error) {
			failure = error instanceof AccountGreetingError ? error : new AccountGreetingError("No se pudo completar el saludo de esta cuenta.", "greeting_failed");
			const message = cleanText(failure.message, account);
			results.push({ account: index + 1, name, status: "error", error: message });
			logError(paintUiText(ui, `cuenta${index + 1} · ${name}: ${message}`, "danger"));
		} finally {
			if (dispatched) await deps.appendUsage({
				source: "cli", operation: "responses", model: ACCOUNT_GREETING_MODEL,
				outcome: result ? "success" : "failure", createdAt: startedAt,
				accountId: workspaceId, email: account.email, accountIndex: index,
				requestId: result?.responseId, statusCode: failure?.statusCode ?? (result ? 200 : null),
				errorCode: failure?.code, durationMs: Math.max(0, deps.now() - startedAt),
				...result?.usage,
			}).catch(() => logError(`cuenta${index + 1}: no se pudo guardar el uso local.`));
		}
	}
	const completed = results.filter(row => row.status === "ok").length;
	const failed = results.length - completed;
	if (options.json) logInfo(JSON.stringify({ model: ACCOUNT_GREETING_MODEL, prompt: ACCOUNT_GREETING_PROMPT, results, summary: { total: accounts.length, completed, failed } }, null, 2));
	else logInfo(`Saludos completados: ${completed}/${accounts.length} · errores: ${failed}.`);
	if (!accounts.length) logError("No hay cuentas configuradas. Ejecuta codex-multi-auth login.");
	return accounts.length > 0 && failed === 0 ? 0 : 1;
}
