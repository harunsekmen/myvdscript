import { api, type WhisperStatus } from "./api";
import type { Settings } from "./types";

/** Yerel Whisper modelleri (whisper.cpp ggml). Boyutlar yaklaşık indirme boyutudur. */
export const WHISPER_MODELS: { id: string; label: string; size: string; note: string }[] = [
  { id: "large-v3-turbo-q5_0", label: "Large v3 Turbo (sıkıştırılmış)", size: "574 MB", note: "Önerilen: Türkçede iyi, hızlı" },
  { id: "large-v3-turbo-q8_0", label: "Large v3 Turbo (q8)", size: "874 MB", note: "Biraz daha doğru, daha yavaş" },
  { id: "large-v3-turbo", label: "Large v3 Turbo (tam)", size: "1,6 GB", note: "En doğru turbo, yavaş" },
  { id: "large-v3-q5_0", label: "Large v3 (sıkıştırılmış)", size: "1,1 GB", note: "En doğru, en yavaş" },
  { id: "medium-q5_0", label: "Medium (sıkıştırılmış)", size: "539 MB", note: "Orta" },
  { id: "small", label: "Small", size: "488 MB", note: "Hızlı, Türkçede zayıf" },
  { id: "base", label: "Base", size: "148 MB", note: "Çok hızlı, düşük doğruluk" },
  { id: "tiny", label: "Tiny", size: "78 MB", note: "Deneme amaçlı" },
];

// ---- İndirilmiş yerel modellerin durumu (uygulama genelinde paylaşılır)

let status: WhisperStatus | null = null;
const subs = new Set<() => void>();

export function whisperStatus(): WhisperStatus | null {
  return status;
}

export function subscribeWhisper(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export async function refreshWhisper(): Promise<WhisperStatus | null> {
  try {
    status = await api.whisperStatus();
  } catch {
    status = null;
  }
  subs.forEach((f) => f());
  return status;
}

export function modelInstalled(id: string): boolean {
  return !!status?.engine && !!status.models.some((m) => m.id === id);
}

/** Seçili motor kullanılabilir mi (Groq anahtarı ya da indirilmiş yerel model)? */
export function sttReady(s: Pick<Settings, "sttEngine" | "whisperModel">, hasGroqKey: boolean): boolean {
  return s.sttEngine === "local" ? modelInstalled(s.whisperModel) : hasGroqKey;
}

/** Motor hazır değilse gösterilecek açıklama. */
export function sttMissingMessage(s: Pick<Settings, "sttEngine">): string {
  return s.sttEngine === "local"
    ? "Yerel Whisper modeli indirilmemiş: Ayarlar › Ses ve YouTube bölümünden indirin"
    : "Yazıya çevirmek için Ayarlar'dan Groq API anahtarını girin";
}

export function sttOptions(s: Pick<Settings, "sttEngine" | "whisperModel">, language: string) {
  return { language, engine: s.sttEngine, model: s.whisperModel };
}
