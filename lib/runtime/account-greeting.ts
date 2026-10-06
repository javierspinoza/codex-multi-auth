import { randomUUID } from "node:crypto";
import { CODEX_BASE_URL } from "../constants.js";
import type { CodexQuotaSnapshot } from "../quota-probe.js";
import { createCodexHeaders } from "../request/headers.js";
import { resolveProbeReasoningEffort } from "../request/helpers/model-map.js";
import { convertSseToJson } from "../request/response-handler.js";
import type { RequestBody } from "../types.js";
import { extractResponsesUsage } from "../usage/usage-extraction.js";
import type { UsageTokenCounts } from "../usage/types.js";
import { isRecord } from "../utils.js";
import { parseCodexQuotaSnapshot } from "./quota-headers.js";

export const ACCOUNT_GREETING_MODEL = "gpt-6-luna";
export const ACCOUNT_GREETING_PROMPT = "hola";

export class AccountGreetingError extends Error {
	constructor(message: string, readonly code: string, readonly statusCode?: number) {
		super(message);
	}
}

export interface AccountGreetingResult {
	text: string;
	responseId?: string;
	quota: CodexQuotaSnapshot | null;
	usage: UsageTokenCounts | null;
}

/** A fresh, single-turn conversation with the supplied account; no rotation or model fallback. */
export async function sendAccountGreeting(
	params: { accountId: string; accessToken: string },
	fetchImpl: typeof fetch = fetch,
): Promise<AccountGreetingResult> {
	const conversationId = randomUUID();
	const headers = createCodexHeaders(undefined, params.accountId, params.accessToken, {
		model: ACCOUNT_GREETING_MODEL,
		promptCacheKey: conversationId,
	});
	headers.set("content-type", "application/json");
	const body: RequestBody = {
		model: ACCOUNT_GREETING_MODEL,
		instructions: "Responde al saludo con una frase breve en español.",
		input: [{ type: "message", role: "user", content: [{ type: "input_text", text: ACCOUNT_GREETING_PROMPT }] }],
		stream: true,
		store: false,
		prompt_cache_key: conversationId,
		reasoning: { effort: resolveProbeReasoningEffort(ACCOUNT_GREETING_MODEL), summary: "auto" },
		text: { verbosity: "low" },
	};
	const controller = new AbortController();
	// Keep the deadline active while consuming the body, not just until headers arrive.
	const timeout = setTimeout(() => controller.abort(), 60_000);
	let response: Response | undefined;
	let receivingBody = false;
	try {
		response = await fetchImpl(`${CODEX_BASE_URL}/codex/responses`, {
			method: "POST", headers, body: JSON.stringify(body),
			signal: controller.signal, redirect: "error",
		});
		if (!response.ok) {
			const status = response.status;
			const message = status === 401 ? "La cuenta necesita renovar su sesión."
				: status === 403 ? "GPT-6 Luna no está disponible o la cuenta no tiene permiso."
					: status === 429 ? "La cuenta no tiene cuota disponible o alcanzó un límite de solicitudes."
						: `El servicio rechazó el saludo (HTTP ${status}).`;
			throw new AccountGreetingError(message, `http_${status}`, status);
		}
		const observedAt = Date.now();
		const quota = parseCodexQuotaSnapshot(response.headers, response.status);
		receivingBody = true;
		// Codex sometimes omits Content-Type on a successful streaming response.
		// We requested stream:true, so only an explicit JSON response opts out of SSE.
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		const decoded = contentType.includes("application/json")
			? response
			: await convertSseToJson(response, response.headers, { streamStallTimeoutMs: 15_000 });
		const result: unknown = await decoded.json();
		if (!decoded.ok || !isRecord(result) || result.status !== "completed") {
			throw new AccountGreetingError("El saludo no se completó; no se vuelve a enviar automáticamente.", "incomplete_response", decoded.status);
		}
		const text = typeof result.output_text === "string" ? result.output_text :
			(Array.isArray(result.output) ? result.output : []).flatMap(item =>
				isRecord(item) && item.type === "message" && item.role === "assistant" && Array.isArray(item.content)
					? item.content.flatMap(part => isRecord(part) && part.type === "output_text" && typeof part.text === "string" ? [part.text] : [])
					: []).join("\n");
		if (!text.trim()) throw new AccountGreetingError("El servicio completó el saludo sin una respuesta de texto.", "empty_response", response.status);
		return {
			text: text.split(params.accessToken).join("[REDACTED]"),
			responseId: typeof result.id === "string" ? result.id : undefined,
			quota: quota ? { ...quota, observedAt, model: ACCOUNT_GREETING_MODEL, primingCompleted: true, primingObservedAt: Date.now() } : null,
			usage: extractResponsesUsage(result),
		};
	} catch (error) {
		if (error instanceof AccountGreetingError) throw error;
		const cause = isRecord(error) ? error.cause : undefined;
		const networkCode = isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined;
		if (networkCode && ["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(networkCode)) {
			throw new AccountGreetingError(`No se pudo conectar con Codex (${networkCode}); comprueba la conexión.`, "network_error");
		}
		throw new AccountGreetingError(
			controller.signal.aborted ? "El saludo superó el tiempo máximo de 60 segundos."
				: receivingBody ? "No se pudo leer la respuesta del saludo (JSON/SSE incompleto o inválido)."
					: "No se pudo conectar con Codex para enviar el saludo.",
			controller.signal.aborted ? "timeout" : receivingBody ? "invalid_response" : "request_failed",
			response?.status,
		);
	} finally {
		clearTimeout(timeout);
		controller.abort();
		if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
	}
}
