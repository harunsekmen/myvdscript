/** Kısayol tuşları: "Ctrl+Shift+M", "Space", "Enter" gibi metinlerle saklanır ve eşlenir. */

const MOD_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS"]);

/** Klavye olayının tuş adı (harfler büyük, boşluk "Space"). */
function keyName(key: string): string {
  if (key === " " || key === "Spacebar") return "Space";
  if (key === "Esc") return "Escape";
  if (key.length === 1) return key.toLocaleUpperCase("tr");
  return key;
}

/** Olaydan kısayol metni üretir; yalnız değiştirici tuşa basıldıysa null. */
export function comboFromEvent(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): string | null {
  if (MOD_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(keyName(e.key));
  return parts.join("+");
}

/** Olay bu kısayola uyuyor mu (değiştiriciler birebir eşleşmeli). */
export function matchCombo(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">, combo: string): boolean {
  if (!combo) return false;
  const got = comboFromEvent(e);
  if (!got) return false;
  if (got === combo) return true;
  // Shift'li harf kısayolu: "Shift+R" kaydedildiğinde key zaten büyük harf gelir; eşleşme aynı kalır.
  return got.toLocaleUpperCase("tr") === combo.toLocaleUpperCase("tr");
}

const PRETTY: Record<string, string> = {
  Space: "Boşluk",
  Escape: "Esc",
  Delete: "Del",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Backspace: "⌫",
};

/** Görüntülenecek kısayol metni. */
export function prettyCombo(combo: string): string {
  if (!combo) return "—";
  return combo
    .split("+")
    .map((p) => PRETTY[p] ?? p)
    .join("+");
}
