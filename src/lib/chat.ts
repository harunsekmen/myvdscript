import type { ChatMessage, Segment } from "./types";

/** Bağlam olarak gönderilecek kaynak metnin üst sınırı (karakter); uzun videolarda baştan/sondan kırpılır. */
export const CHAT_CONTEXT_MAX = 60000;
/** Modele gönderilen önceki mesaj sayısı (en yeniler). */
export const CHAT_HISTORY_MAX = 20;

export const CHAT_SYSTEM_PROMPT = `Sen bilgili ve yardımsever bir araştırma asistanısın. Kullanıcı bir YouTube videosunun Türkçe'ye düzenlenmiş metni üzerinde çalışıyor ve bu metinle ilgili sorular soracak.

Kurallar:
- Türkçe yanıt ver. Net ve öz ol; soru gerektirmedikçe uzun yazma.
- Önce aşağıdaki kaynak metne dayan. Metinde olmayan bir bilgiyi kendi bilginden ekliyorsan bunu açıkça belirt ("Metinde geçmiyor ama…").
- Metindeki iddiaların doğruluğu sorulursa kendi bilginle değerlendir; emin değilsen bunu söyle, tahmini kesinmiş gibi sunma.
- Web araması yapamazsın.
- Gerektiğinde Markdown (kalın, liste, kod) kullanabilirsin.`;

/** Bölümleri başlıklarıyla düz metne çevirir; sınırı aşarsa ortasından kırpar. */
export function sourceContext(segments: Segment[], max = CHAT_CONTEXT_MAX): string {
  const full = segments
    .map((s) => (s.title ? `## ${s.title}\n\n${s.text.trim()}` : s.text.trim()))
    .filter(Boolean)
    .join("\n\n");
  if (full.length <= max) return full;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${full.slice(0, head)}\n\n[… metnin ortası uzunluk nedeniyle çıkarıldı …]\n\n${full.slice(full.length - tail)}`;
}

export function buildChatSystem(title: string, segments: Segment[]): string {
  const ctx = sourceContext(segments);
  const head = title.trim() ? `Video başlığı: ${title.trim()}\n\n` : "";
  return `${CHAT_SYSTEM_PROMPT}\n\n${head}KAYNAK METİN:\n\n${ctx || "(henüz metin yok)"}`;
}

/** Kullanıcı mesajını (varsa seçili alıntıyla) modele gidecek metne çevirir. */
export function chatUserText(m: Pick<ChatMessage, "text" | "quote">): string {
  const q = m.quote?.trim();
  return q ? `Metinden alıntı:\n> ${q.replace(/\n+/g, " ")}\n\n${m.text}` : m.text;
}

/** Önceki mesajları modele gidecek geçmişe çevirir (boş/yarım yanıtlar atlanır). */
export function chatHistory(msgs: ChatMessage[], max = CHAT_HISTORY_MAX) {
  return msgs
    .filter((m) => m.text.trim())
    .slice(-max)
    .map((m) => ({ role: m.role, content: m.role === "user" ? chatUserText(m) : m.text }));
}
