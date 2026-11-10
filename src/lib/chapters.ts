/** Video bölüm başlıklarının AI ile Türkçe'ye çevrilmesi. */

export const CHAPTER_PROMPT = `Sana bir YouTube videosunun bölüm başlıkları numaralı liste olarak verilecek. Her başlığı doğal, kısa bir Türkçe'ye çevir.

Kurallar:
- Marka, ürün, uygulama, kişi ve kurum adlarını çevirme; olduğu gibi bırak (ör. Claude Code, TokenEconomizer, SWE-Bench).
- Yaygın teknik terimleri (API, token, repository, plugin gibi) gerekirse İngilizce bırakabilirsin.
- Sayıları, yüzdeleri aynen koru. Anlamı değiştirme, ekleme yapma.
- Başlık zaten Türkçe ise aynen yaz.
- Yanıtı YALNIZCA şu JSON biçiminde ver, başka hiçbir şey yazma: {"titles":["1. başlığın çevirisi","2. başlığın çevirisi"]}
- Dizide giriş sayısı kadar öğe olmalı ve sıra korunmalı.`;

export function buildChapterMessage(titles: string[]): string {
  return `Bölüm başlıkları (${titles.length} adet):\n${titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
}

/** Model yanıtından çevirileri ayıklar; sayı tutmazsa ya da bozuksa null döner. */
export function parseChapterTitles(text: string, count: number): string[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const titles = (JSON.parse(text.slice(start, end + 1)) as { titles?: unknown }).titles;
    if (!Array.isArray(titles) || titles.length !== count) return null;
    const out = titles.map((t) => (typeof t === "string" ? t.trim() : ""));
    return out.every(Boolean) ? out : null;
  } catch {
    return null;
  }
}

/** Kayıtlı çeviri bu bölüm listesine mi ait? (Video bilgisi değişirse yeniden çevrilir.) */
export const sameTitles = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
