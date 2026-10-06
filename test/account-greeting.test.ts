import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountGreetingError, sendAccountGreeting } from "../lib/runtime/account-greeting.js";

const credentials = { accountId: "fixture-account", accessToken: "fixture-access-secret" };
const completed = { id: "resp_fixture", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "¡Hola!" }] }], usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } };
const sse = (event: unknown) => new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });

afterEach(() => vi.useRealTimers());

describe("account greeting requests", () => {
	it("sends exactly hola with Luna and independent conversation IDs, consuming the completed stream", async () => {
		const request = vi.fn<typeof fetch>().mockImplementation(async () => sse({ type: "response.completed", response: completed }));
		const result = await sendAccountGreeting(credentials, request);
		expect(result).toMatchObject({ text: "¡Hola!", responseId: "resp_fixture", quota: null, usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } });
		await sendAccountGreeting({ accountId: "fixture-two", accessToken: "fixture-two-secret" }, request);
		const bodies = request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
		for (const body of bodies) {
			expect(body).toMatchObject({ model: "gpt-6-luna", stream: true, store: false, reasoning: { effort: "low" }, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hola" }] }] });
			expect(body).not.toHaveProperty("previous_response_id");
			expect(body).not.toHaveProperty("tools");
		}
		expect(bodies[0].prompt_cache_key).not.toBe(bodies[1].prompt_cache_key);
		const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
		expect(headers.get("authorization")).toBe("Bearer fixture-access-secret");
		expect(headers.get("chatgpt-account-id")).toBe("fixture-account");
		expect(headers.get("session_id")).toBe(bodies[0].prompt_cache_key);
		expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
	});

	it("retains observed quotas after a completed greeting and accepts JSON responses", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(completed), { headers: { "content-type": "application/json", "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "300" } }));
		expect(await sendAccountGreeting(credentials, request)).toMatchObject({ text: "¡Hola!", quota: { model: "gpt-6-luna", status: 200, primingCompleted: true, primary: { usedPercent: 10, windowMinutes: 300 } } });
	});

	it.each([undefined, "application/octet-stream", "text/plain"])("reads completed SSE when Content-Type is %s", async contentType => {
		const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`);
		const response = new Response(bytes, { headers: contentType ? { "content-type": contentType } : undefined });
		const request = vi.fn<typeof fetch>().mockResolvedValue(response);
		expect(await sendAccountGreeting(credentials, request)).toMatchObject({ text: "¡Hola!", responseId: "resp_fixture", usage: { totalTokens: 12 } });
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("distinguishes a malformed successful reply from a transport failure", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("not JSON", { headers: { "content-type": "application/json" } }));
		await expect(sendAccountGreeting(credentials, request)).rejects.toMatchObject({ code: "invalid_response", statusCode: 200 });
	});

	it("reports safe network error codes without leaking the raw cause", async () => {
		const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error(credentials.accessToken), { code: "EAI_AGAIN" }) }));
		const error = await sendAccountGreeting(credentials, request).catch(error => error);
		expect(error.code).toBe("network_error");
		expect(error.message).toContain("EAI_AGAIN");
		expect(error.message).not.toContain(credentials.accessToken);
	});

	it.each([401, 403, 429, 500])("reports HTTP %i without retrying, falling back or exposing the error body", async status => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(`upstream-secret: ${credentials.accessToken}`, { status }));
		const error = await sendAccountGreeting(credentials, request).catch(error => error);
		expect(error).toBeInstanceOf(AccountGreetingError);
		expect(error.statusCode).toBe(status);
		expect(error.message).not.toContain(credentials.accessToken);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it.each(["response.failed", "response.incomplete", "error"])("does not treat a %s event as a successful greeting", async type => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type, response: { ...completed, status: "failed" } }));
		await expect(sendAccountGreeting(credentials, request)).rejects.toBeInstanceOf(AccountGreetingError);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a truncated stream and a completed response without text", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValueOnce(sse({ type: "response.output_text.delta", delta: "Hola" })).mockResolvedValueOnce(sse({ type: "response.completed", response: { status: "completed", output: [] } }));
		await expect(sendAccountGreeting(credentials, request)).rejects.toBeInstanceOf(AccountGreetingError);
		await expect(sendAccountGreeting(credentials, request)).rejects.toMatchObject({ code: "empty_response" });
	});

	it("keeps the overall deadline active after headers arrive", async () => {
		vi.useFakeTimers();
		const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(new ReadableStream({
			start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted"))); },
		}), { headers: { "content-type": "application/json" } }));
		const pending = sendAccountGreeting(credentials, request);
		const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
		await vi.advanceTimersByTimeAsync(60_000);
		await assertion;
	});
});
