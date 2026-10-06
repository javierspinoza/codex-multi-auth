import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JWT_CLAIM_PATH } from "../lib/constants.js";
import { persistAccountPool } from "../lib/codex-manager/login-oauth.js";
import {
	cloneTrackedAccountStorage,
	loadAccounts,
	saveAccounts,
	setStoragePath,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

function account(id: string): AccountMetadataV3 {
	return {
		recordId: `record-${id}`,
		accountId: `acc_${id}`,
		email: `${id}@example.com`,
		refreshToken: `fixture-refresh-${id}`,
		accessToken: `fixture-access-${id}`,
		addedAt: 1,
		lastUsed: 1,
	};
}

function login(id: string) {
	const payload = { email: `${id}@example.com`, [JWT_CLAIM_PATH]: { chatgpt_account_id: `acc_${id}` } };
	const token = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`;
	return {
		type: "success" as const,
		access: token,
		idToken: token,
		refresh: `fixture-new-refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountLabel: "New account",
		workspaces: [{ id: `acc_${id}`, name: "Personal", enabled: true }],
	};
}

async function pool(): Promise<AccountStorageV3> {
	const storage = await loadAccounts();
	if (!storage) throw new Error("Expected test account pool");
	return storage;
}

describe("replacing saved accounts through real storage transactions", () => {
	let directory: string;
	let originalDirectory: string | undefined;

	beforeEach(async () => {
		originalDirectory = process.env.CODEX_MULTI_AUTH_DIR;
		directory = await mkdtemp(join(tmpdir(), "cma-replace-account-"));
		process.env.CODEX_MULTI_AUTH_DIR = directory;
		setStoragePath(null);
		await saveAccounts({
			version: 3,
			accounts: Array.from({ length: 16 }, (_, index) => account(`user${index + 1}`)),
			activeIndex: 0,
			activeIndexByFamily: { codex: 0, "codex-max": 8 },
			pinnedAccountIndex: 8,
			affinityGeneration: 7,
		});
	});

	afterEach(async () => {
		if (originalDirectory === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
		else process.env.CODEX_MULTI_AUTH_DIR = originalDirectory;
		setStoragePath(null);
		await removeWithRetry(directory, { recursive: true, force: true });
	});

	it.each([0, 8, 15])("keeps all sixteen positions when replacing index %s", async (index) => {
		const before = await pool();
		const expected = before.accounts[index]!;
		Object.assign(expected, {
			rateLimitResetTimes: { codex: Date.now() + 600_000 },
			coolingDownUntil: Date.now() + 600_000,
			cooldownReason: "auth-failure",
			authInvalidatedAt: 100,
			authInvalidationErrorCode: "refresh_token_expired",
			codexCliMirror: { forAccountId: expected.accountId, accountId: "old-mirror" },
			workspaces: [{ id: "old-workspace", enabled: false }],
		});
		await saveAccounts(before);
		const result = await persistAccountPool([login("replacement")], false, {
			expectedAccount: expected,
			expectedAccountIndex: index,
			replaceAccount: true,
		});
		const after = await pool();
		expect(after.accounts).toHaveLength(16);
		expect(after.accounts.filter((_, i) => i !== index)).toEqual(before.accounts.filter((_, i) => i !== index));
		expect(after.accounts[index]).toMatchObject({
			accountId: "acc_replacement", email: "replacement@example.com",
			refreshToken: "fixture-new-refresh-replacement", enabled: true,
			workspaces: [{ id: "acc_replacement", enabled: true }],
		});
		expect(after.accounts[index]?.recordId).not.toBe(expected.recordId);
		for (const field of ["rateLimitResetTimes", "coolingDownUntil", "cooldownReason", "authInvalidatedAt", "authInvalidationErrorCode", "codexCliMirror"]) {
			expect(after.accounts[index]).not.toHaveProperty(field);
		}
		expect(after.activeIndex).toBe(0);
		expect(after.activeIndexByFamily?.codex).toBe(0);
		expect(after.activeIndexByFamily?.["codex-max"]).toBe(8);
		expect(after.pinnedAccountIndex).toBe(8);
		expect(after.affinityGeneration).toBe(8);
		expect(result).toMatchObject({ outcome: "replaced", accountIndex: index, isActiveAccount: index === 0 });
	});

	it("preserves a disabled slot and publishes whether it owns the Codex family selection", async () => {
		const before = await pool();
		before.accounts[8]!.enabled = false;
		before.activeIndexByFamily!.codex = 8;
		await saveAccounts(before);
		const result = await persistAccountPool([login("replacement")], false, {
			expectedAccount: before.accounts[8], expectedAccountIndex: 8, replaceAccount: true,
		});
		expect((await pool()).accounts[8]?.enabled).toBe(false);
		expect(result).toMatchObject({ accountIndex: 8, activeIndex: 0, isActiveAccount: true, accountEnabled: false });
	});

	it("does not resurrect the old user when a stale runtime snapshot is saved", async () => {
		const stale = await pool();
		await persistAccountPool([login("replacement")], false, {
			expectedAccount: stale.accounts[8], expectedAccountIndex: 8, replaceAccount: true,
		});
		stale.accounts[8]!.lastUsed = Date.now();
		stale.accounts[8]!.refreshToken = "fixture-late-old-refresh";
		await saveAccounts(stale);
		const after = await pool();
		expect(after.accounts).toHaveLength(16);
		expect(after.accounts[8]?.accountId).toBe("acc_replacement");
		expect(after.accounts.some((row) => row.accountId === "acc_user9")).toBe(false);
	});

	it("accepts a runtime refresh of the target while the new login is underway", async () => {
		const before = await pool();
		const concurrent = cloneTrackedAccountStorage(before);
		concurrent.accounts[8]!.refreshToken = "fixture-runtime-refreshed";
		await saveAccounts(concurrent);
		await persistAccountPool([login("replacement")], false, {
			expectedAccount: before.accounts[8], expectedAccountIndex: 8, replaceAccount: true,
		});
		expect((await pool()).accounts[8]?.accountId).toBe("acc_replacement");
	});

	it("rejects an account already saved elsewhere without changing either account", async () => {
		const before = await pool();
		await expect(persistAccountPool([login("user10")], false, {
			expectedAccount: before.accounts[8], expectedAccountIndex: 8, replaceAccount: true,
		})).rejects.toThrow("already saved in another position");
		expect(await pool()).toEqual(before);
	});

	it.each(["removed", "moved", "replaced"])("rejects a target %s by another command during login", async (change) => {
		const before = await pool();
		const current = cloneTrackedAccountStorage(before);
		if (change === "removed") current.accounts.splice(8, 1);
		else if (change === "moved") current.accounts.splice(1, 1);
		else current.accounts[8]!.recordId = "different-record-same-user";
		await saveAccounts(current);
		const disk = await pool();
		await expect(persistAccountPool([login("replacement")], false, {
			expectedAccount: before.accounts[8], expectedAccountIndex: 8, replaceAccount: true,
		})).rejects.toThrow(/No saved credentials were changed/);
		expect(await pool()).toEqual(disk);
	});

	it("continues refusing a different identity during ordinary targeted re-authentication", async () => {
		const before = await pool();
		await expect(persistAccountPool([login("replacement")], false, {
			expectedAccount: before.accounts[8], expectedAccountIndex: 8, preserveSelection: true,
		})).rejects.toThrow("does not match");
		expect(await pool()).toEqual(before);
	});

	it("requires one OAuth result and one existing replacement target", async () => {
		const before = await pool();
		await expect(persistAccountPool([login("replacement")], false, { replaceAccount: true })).rejects.toThrow("requires one saved target");
		await expect(persistAccountPool([login("replacement")], true, {
			expectedAccount: before.accounts[8], replaceAccount: true,
		})).rejects.toThrow("cannot replace the entire pool");
		await expect(persistAccountPool([login("replacement"), login("other")], false, {
			expectedAccount: before.accounts[8], replaceAccount: true,
		})).rejects.toThrow("exactly one OAuth result");
		expect(await pool()).toEqual(before);
	});
});
