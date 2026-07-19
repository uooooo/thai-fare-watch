// クエリパラメータの"鍵"としてよくある秘密系の名前。値を"***"に伏せる対象(大文字小文字は無視)。
const SECRET_QUERY_KEY_RE =
	/^(api_key|apikey|token|key|secret|sig|signature|password|access_token)$/i;

// Discord webhook: https://discord.com/api/webhooks/<id>/<token> —tokenそのものが秘密で、
// クエリパラメータではなくパスの一部として乗っている特殊系(ホスト名には依存しない —プロキシ経由
// でも同じパス形状なら伏せられるようにする)。
const WEBHOOK_TOKEN_RE = /(\/api\/webhooks\/\d+\/)[^/?#]+/;

// クエリの`key=value`を文字列のまま伏せる(new URL()がパースに失敗した場合のfallback用)。
// 本来のURLとして不正な入力でも、少なくとも秘密らしき部分だけは確実に伏せて返す。
const SECRET_QUERY_VALUE_RE =
	/([?&](?:api_key|apikey|token|key|secret|sig|signature|password|access_token)=)[^&#]*/gi;

function regexScrub(raw: string): string {
	return raw
		.replace(SECRET_QUERY_VALUE_RE, "$1***")
		.replace(WEBHOOK_TOKEN_RE, "$1***");
}

// URL中の秘密(クエリパラメータの値・Discord webhookのトークンパスセグメント)を"***"に置換して
// 返す。HttpError.message/.urlや将来のあらゆるログ出力の根本対策 —秘密が平文でCLI標準出力/
// health.json(publicリポジトリにcommitされ得る)へ漏れることを構造的に防ぐ。
export function redactUrl(raw: string): string {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return regexScrub(raw);
	}
	for (const key of [...u.searchParams.keys()]) {
		if (SECRET_QUERY_KEY_RE.test(key)) u.searchParams.set(key, "***");
	}
	u.pathname = u.pathname.replace(WEBHOOK_TOKEN_RE, "$1***");
	return u.toString();
}

// URL中のクエリ秘密だけでなく、地の文(生Errorの.message等)に丸ごと埋め込まれたURLも
// 伏せる汎用ヘルパー。文字列中に現れる全てのhttp(s) URLをredactUrlで個別に伏せる。
export function scrubUrls(text: string): string {
	return text.replace(/https?:\/\/[^\s"'`<>]+/g, (m) => redactUrl(m));
}

export class HttpError extends Error {
	public status: number;
	public url: string;
	public body?: string;

	constructor(status: number, url: string, body?: string) {
		// bodyはmessageに含めない —レスポンス本文が秘密をエコーし返すケースもあるため。必要なら
		// 呼び出し側は.bodyフィールドを個別に見る(ただしそちらも表示・ログ時は呼び出し側の責任で
		// 秘密混入に注意すること)。
		super(`HTTP ${status} for ${redactUrl(url)}`);
		this.name = "HttpError";
		this.status = status;
		// 生URL(秘密を含み得る)は保持しない —どの消費者にとってもredact済みで十分
		// (health.json送り/CLI出力送りいずれの将来の使途でも安全側に倒す)。
		this.url = redactUrl(url);
		this.body = body;
	}
}

// 生のError objectを渡すとBunの network error が enumerable な `.path`(生URL=秘密) を持ち、
// console が展開して漏らす。必ず safeErrorMessage で **文字列** に変換してからログする。
export function safeErrorMessage(err: unknown): string {
	if (err instanceof HttpError) return err.message; // 既にredact済み・bodyを含まない
	if (err instanceof Error) return scrubUrls(err.message); // .path/.stack/オブジェクトは決して触らない
	return scrubUrls(String(err));
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
