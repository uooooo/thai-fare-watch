export function stableId(...parts: (string | number | undefined)[]): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(parts.map((p) => String(p ?? "")).join(" "));
	return h.digest("hex").slice(0, 12);
}
