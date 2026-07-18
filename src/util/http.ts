export class HttpError extends Error {
	constructor(
		public status: number,
		public url: string,
		body?: string,
	) {
		super(`HTTP ${status} for ${url}${body ? `: ${body}` : ""}`);
		this.name = "HttpError";
	}
}

type FetchOptions = RequestInit & {
	timeoutMs?: number; // 既定15000
	retries?: number; // 既定3（429/5xx/ネットワークエラーのみ）
	fetchImpl?: typeof fetch; // テスト注入用
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const MAX_BACKOFF_MS = 8000;

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
	return Math.min(2 ** attempt * 500 + Math.random() * 250, MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
	url: string,
	init?: FetchOptions,
): Promise<Response> {
	const {
		timeoutMs = DEFAULT_TIMEOUT_MS,
		retries = DEFAULT_RETRIES,
		fetchImpl = fetch,
		...rest
	} = init ?? {};

	for (let attempt = 0; ; attempt++) {
		let res: Response;
		try {
			res = await fetchImpl(url, {
				...rest,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			// fetch自体の例外（ネットワークエラー・タイムアウト等）はリトライ対象
			if (attempt >= retries) throw err;
			await sleep(backoffMs(attempt));
			continue;
		}

		if (res.ok) return res;

		if (!isRetryableStatus(res.status) || attempt >= retries) {
			const body = await res.text().catch(() => undefined);
			throw new HttpError(res.status, url, body);
		}
		await sleep(backoffMs(attempt));
	}
}

export async function fetchJson<T = unknown>(
	url: string,
	init?: FetchOptions,
): Promise<T> {
	const res = await fetchWithRetry(url, init);
	return (await res.json()) as T;
}

export async function fetchText(
	url: string,
	init?: FetchOptions,
): Promise<string> {
	const res = await fetchWithRetry(url, init);
	return await res.text();
}
