import type { SubOption } from "./api";

const isEnglish = (lang: string) => /^en(-|$)/i.test(lang);

/**
 * Varsayılan altyazı: İngilizce tercih edilir (elle yazılmış ya da otomatik).
 * Sıra: en (elle) > en (otomatik) > en-* (elle) > en-* (otomatik).
 * İngilizce yoksa: ilk elle yazılmış, yoksa ilk seçenek.
 */
export function defaultSubtitle(options: SubOption[]): SubOption | undefined {
  const en = options.filter((o) => isEnglish(o.lang));
  if (!en.length) return options.find((o) => !o.auto) ?? options[0];
  const exact = (o: SubOption) => o.lang.toLowerCase() === "en";
  return (
    en.find((o) => exact(o) && !o.auto) ??
    en.find((o) => exact(o)) ??
    en.find((o) => !o.auto) ??
    en[0]
  );
}

/** Seçenekleri arama metnine göre süzer (dil kodu ya da adında geçen). */
export function filterSubtitles(options: SubOption[], query: string): SubOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.lang.toLowerCase().includes(q) || o.name.toLowerCase().includes(q));
}
