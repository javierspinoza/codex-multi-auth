import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { AccountManager, ManagedAccount } from "../accounts.js";
import type { ModelFamily } from "../prompts/codex.js";
import { getStoragePath, loadAccounts } from "../storage.js";
import {
	getJsonStoreFileMtimeMs,
	withJsonStoreCasRetry,
	withJsonStoreFileLock,
	withJsonStoreWriteQueue,
	writeJsonStoreFileAtomicWithRetry,
} from "../storage/json-store-lock.js";
import { inferenceAccountKey } from "./inference-activity.js";

const stateSchema = z.object({
	version: z.literal(1),
	accountKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	affinityGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	updatedAt: z.number().finite().positive(),
	blockedAccounts: z.record(z.string().regex(/^sha256:[a-f0-9]{64}$/), z.object({ until: z.number().finite().positive(), observedAt: z.number().finite().positive(), kind: z.enum(["quota", "failure"]), failureUntil: z.number().finite().positive().optional() })).default({}),
});

export async function loadSequentialPrimaryAccountKey(storagePath = getStoragePath()): Promise<string | null> {
	try {
		return stateSchema.parse(JSON.parse(await fs.readFile(`${storagePath}.sequential-routing.json`, "utf8"))).accountKey;
	} catch {
		return null;
	}
}

/** One primary per account pool, shared by projects, models and proxy processes. */
export class SequentialAccountCoordinator {
	constructor(private readonly path = `${getStoragePath()}.sequential-routing.json`) {}

	async recordUnavailable(account: ManagedAccount, until: number, kind: "quota" | "failure" = "failure"): Promise<void> {
		if (!Number.isFinite(until) || until <= Date.now()) return;
		await withJsonStoreWriteQueue(this.path, () => withJsonStoreFileLock(this.path, () => withJsonStoreCasRetry(async () => {
			const expectedMtimeMs = await getJsonStoreFileMtimeMs(this.path);
			if (expectedMtimeMs === null) return;
			const state = stateSchema.parse(JSON.parse(await fs.readFile(this.path, "utf8")));
			const key = inferenceAccountKey(account);
			const previous = state.blockedAccounts[key];
			const failureUntil = Math.max(previous?.failureUntil ?? 0, previous?.kind === "failure" ? previous.until : 0, kind === "failure" ? until : 0);
			state.blockedAccounts[key] = kind === "failure" && previous?.kind === "quota"
				? { ...previous, failureUntil }
				: { until: Math.max(previous?.until ?? 0, until), observedAt: Date.now(), kind, ...(failureUntil > 0 ? { failureUntil } : {}) };
			state.blockedAccounts[key].until = Math.max(state.blockedAccounts[key].until, failureUntil);
			await writeJsonStoreFileAtomicWithRetry(this.path, state, { expectedMtimeMs, mode: 0o600 });
		})));
	}

	async select(params: {
		manager: AccountManager;
		family: ModelFamily;
		affinityGeneration: number;
		select: (blockedIndexes: ReadonlySet<number>) => ManagedAccount | null;
		canRecover?: (account: ManagedAccount, blockedAt: number) => boolean;
	}): Promise<ManagedAccount | null> {
		await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		return withJsonStoreWriteQueue(this.path, () => withJsonStoreFileLock(this.path, () => withJsonStoreCasRetry(async () => {
			const expectedMtimeMs = await getJsonStoreFileMtimeMs(this.path);
			let previous: z.infer<typeof stateSchema> | null = null;
			try {
				previous = stateSchema.parse(JSON.parse(await fs.readFile(this.path, "utf8")));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const affinityGeneration = Math.max(previous?.affinityGeneration ?? 0, params.affinityGeneration);
			let primaryKey = previous?.accountKey;
			// Explicit best/unpin changes invalidate the coordinator's older pointer.
			// Pins bypass this coordinator entirely and remain strict.
			if (previous && previous.affinityGeneration < params.affinityGeneration) {
				const storage = await loadAccounts();
				const index = storage?.activeIndexByFamily?.[params.family] ?? storage?.activeIndex;
				const account = typeof index === "number" ? storage?.accounts[index] : undefined;
				primaryKey = account ? inferenceAccountKey(account) : undefined;
			}
			const primary = params.manager.getAccountsSnapshot().find(account => inferenceAccountKey(account) === primaryKey);
			if (primary) params.manager.adoptActiveAccountForFamily(primary.index, params.family);
			const blockedAccounts = previous?.affinityGeneration === affinityGeneration ? previous.blockedAccounts : {};
			let recovered = false;
			const blockedIndexes = new Set(params.manager.getAccountsSnapshot().filter(account => {
				const blocked = blockedAccounts[inferenceAccountKey(account)];
				if (!blocked || blocked.until <= Date.now()) return false;
				if (blocked.kind === "quota" && (blocked.failureUntil ?? 0) <= Date.now() && params.canRecover?.(account, blocked.observedAt)) {
					blocked.until = Date.now(); recovered = true; return false;
				}
				return true;
			}).map(account => account.index));
			const selected = params.select(blockedIndexes);
			if (!selected) return null;
			const accountKey = inferenceAccountKey(selected);
			if (recovered || previous?.accountKey !== accountKey || previous.affinityGeneration !== affinityGeneration) {
				// Publish before the outbound request. A delayed success on the old
				// primary must never undo a switch made by another request/process.
				await writeJsonStoreFileAtomicWithRetry(this.path, { version: 1, accountKey, affinityGeneration, updatedAt: Date.now(), blockedAccounts }, { expectedMtimeMs, mode: 0o600 });
			}
			params.manager.adoptActiveAccountForFamily(selected.index, params.family);
			return selected;
		})));
	}
}
