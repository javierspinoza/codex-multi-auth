import { describe, expect, it, vi } from "vitest";

import { fetchRuntimeCodexQuotaSnapshot } from "../lib/runtime/quota-probe.js";
import {
	CURRENT_CODEX_MODEL,
	DEFAULT_MODEL,
	DEFAULT_PROBE_MODEL,
} from "../lib/request/helpers/model-map.js";

function makeQuotaHeaders(overrides: Record<string, string> = {}): Headers {
	return new Headers({
		"x-codex-primary-used-percent": "32",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-after-seconds": "120",
		"x-codex-secondary-used-percent": "64",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-after-seconds": "600",
		"x-codex-plan-type": "plus",
		...overrides,
	});
}

describe("fetchRuntimeCodexQuotaSnapshot", () => {
	it("returns a parsed snapshot and preserves the winning model", async () => {
		const parseCodexQuotaSnapshot = vi.fn((_headers: Headers, status: number) => ({
			status,
			planType: "plus",
			activeLimit: 2,
			primary: { usedPercent: 32, windowMinutes: 300, resetAtMs: 1000 },
			secondary: { usedPercent: 64, windowMinutes: 10080, resetAtMs: 2000 },
		}));
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			expect((init?.headers as Headers).get("content-type")).toBe(
				"application/json",
			);
			expect(JSON.parse(String(init?.body))).toMatchObject({
				model: "gpt-6-luna",
				instructions: "instructions:gpt-6-luna",
				stream: true,
				store: false,
				reasoning: { effort: "low" },
			});
			return new Response("", { status: 200, headers: makeQuotaHeaders() });
		});

		const snapshot = await fetchRuntimeCodexQuotaSnapshot({
			accountId: "acc-1",
			accessToken: "token-1",
			baseUrl: "https://example.test",
			fetchImpl,
			getCodexInstructions: async (model: string) => `instructions:${model}`,
			createCodexHeaders: () => new Headers(),
			parseCodexQuotaSnapshot,
			getUnsupportedCodexModelInfo: () => ({ isUnsupported: false }),
		});

		expect(snapshot.model).toBe("gpt-6-luna");
		expect(snapshot.planType).toBe("plus");
		expect(parseCodexQuotaSnapshot).toHaveBeenCalledOnce();
	});

	it.each([
		[CURRENT_CODEX_MODEL, [DEFAULT_PROBE_MODEL]],
		[DEFAULT_MODEL, [DEFAULT_PROBE_MODEL, CURRENT_CODEX_MODEL]],
	] as const)("falls back from Luna to %s when preceding models are unsupported", async (winningModel, unsupportedModels) => {
		const fetchImpl = vi.fn<typeof fetch>();
		for (const model of unsupportedModels) {
			fetchImpl.mockResolvedValueOnce(Response.json({
				error: { message: `Model ${model} unsupported` },
			}, { status: 400 }));
		}
		fetchImpl.mockResolvedValueOnce(
			new Response("", { status: 200, headers: makeQuotaHeaders() }),
		);

		const snapshot = await fetchRuntimeCodexQuotaSnapshot({
			accountId: "acc-1",
			accessToken: "token-1",
			baseUrl: "https://example.test",
			fetchImpl,
			getCodexInstructions: async (model: string) => `instructions:${model}`,
			createCodexHeaders: () => new Headers(),
			parseCodexQuotaSnapshot: (headers: Headers, status: number) =>
				status === 200
					? {
							status,
							planType: "plus",
							activeLimit: 2,
							primary: { usedPercent: 32, windowMinutes: 300, resetAtMs: 1000 },
							secondary: {
								usedPercent: 64,
								windowMinutes: 10080,
								resetAtMs: 2000,
							},
						}
					: null,
			getUnsupportedCodexModelInfo: (_errorBody: unknown) => ({
				isUnsupported: true,
				message: "unsupported",
			}),
		});

		expect(snapshot.model).toBe(winningModel);
		expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual([...unsupportedModels, winningModel]);
	});
});
