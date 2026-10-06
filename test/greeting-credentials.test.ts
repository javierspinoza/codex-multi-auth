import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistGreetingCredentials } from "../lib/codex-manager/list-hola.js";
import { loadAccounts, saveAccounts, setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let dir: string;
const refreshed = { type: "success" as const, access: "fixture-new-access", refresh: "fixture-new-refresh", expires: Date.now() + 3_600_000 };
const pool = (): AccountStorageV3 => ({ version: 3, activeIndex: 0, accounts: [1, 2].map(index => ({ recordId: `fixture-record-${index}`, accountId: `fixture-account-${index}`, accountIdSource: "manual", email: `${index}@example.test`, refreshToken: `fixture-refresh-${index}`, addedAt: index, lastUsed: index })) });

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "cma-greeting-credentials-"));
	setStoragePathDirect(join(dir, "accounts.json"));
	await saveAccounts(pool());
});
afterEach(async () => {
	setStoragePathDirect(null);
	await removeWithRetry(dir, { recursive: true, force: true });
});

describe("greeting credential persistence", () => {
	it("renews the intended record while preserving a concurrent pin, name, workspace and disabled flag", async () => {
		const source = (await loadAccounts())!.accounts[0]!;
		const current = (await loadAccounts())!;
		current.activeIndex = 1;
		current.activeIndexByFamily = { codex: 1 };
		current.pinnedAccountIndex = 1;
		current.affinityGeneration = 8;
		current.accounts[0]!.accountLabel = "Concurrent name";
		current.accounts[0]!.enabled = false;
		current.accounts[0]!.workspaces = [{ id: "fixture-work", enabled: true }];
		await saveAccounts(current);
		await persistGreetingCredentials(source, refreshed);
		const saved = await loadAccounts();
		expect(saved).toMatchObject({ activeIndex: 1, activeIndexByFamily: { codex: 1 }, pinnedAccountIndex: 1, affinityGeneration: 8 });
		expect(saved?.accounts[0]).toMatchObject({ recordId: "fixture-record-1", accessToken: refreshed.access, refreshToken: refreshed.refresh, accountLabel: "Concurrent name", enabled: false, workspaces: [{ id: "fixture-work" }] });
		expect(saved?.accounts[1]?.refreshToken).toBe("fixture-refresh-2");
	});

	it("does not resurrect a removed record or apply its credentials to another record", async () => {
		const source = (await loadAccounts())!.accounts[0]!;
		const current = (await loadAccounts())!;
		current.accounts.splice(0, 1);
		await saveAccounts(current);
		await expect(persistGreetingCredentials(source, refreshed)).rejects.toThrow(/removed/);
		const saved = await loadAccounts();
		expect(saved?.accounts).toHaveLength(1);
		expect(saved?.accounts[0]?.refreshToken).toBe("fixture-refresh-2");
	});

	it("retains fresher credentials written by another process during renewal", async () => {
		const source = (await loadAccounts())!.accounts[0]!;
		const current = (await loadAccounts())!;
		Object.assign(current.accounts[0]!, { refreshToken: "fixture-newer-refresh", accessToken: "fixture-newer-access", expiresAt: Date.now() + 7_200_000 });
		await saveAccounts(current);
		const result = await persistGreetingCredentials(source, refreshed);
		expect(result.accessToken).toBe("fixture-newer-access");
		expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("fixture-newer-refresh");
	});
});
