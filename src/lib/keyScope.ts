/**
 * Klavye kısayollarının kimde olduğu. Tam ekran video, kare görüntüleyici gibi katmanlar ya da odaktaki video,
 * pencere genelindeki kısayolları (ör. ses kayıtları panelinin Boşluk/ok tuşları) devre dışı bırakır.
 *
 * - "exclusive": ekranı kaplayan katman açık; arkadaki panellerin hiçbir kısayolu çalışmaz.
 * - "local": video odakta / fare üzerinde; yalnızca panel içi tuşlar (Boşluk, oklar…) ona bırakılır,
 *   her yerden çalışan genel kısayollar (ör. kayıt başlat) çalışmaya devam eder.
 */
export type KeyClaim = "exclusive" | "local" | null;

const claims = new Set<() => KeyClaim>();

/** Kısayol sahipliği bildirir; dönen işlev kaydı kaldırır. */
export function claimKeys(fn: () => KeyClaim): () => void {
  claims.add(fn);
  return () => {
    claims.delete(fn);
  };
}

/** En güçlü etkin talep. */
export function keysClaimed(): KeyClaim {
  let out: KeyClaim = null;
  for (const f of claims) {
    const c = f();
    if (c === "exclusive") return c;
    if (c === "local") out = c;
  }
  return out;
}
