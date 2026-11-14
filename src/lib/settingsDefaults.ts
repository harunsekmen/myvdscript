import { DEFAULT_INSIGHT_PROMPT, DEFAULT_SYSTEM_PROMPT } from "./prompts";
import type { Settings, StageDef, VoiceKeyAction } from "./types";

/** Varsayılan aşamalar; "idea", "processed" ve "writing" kimlikleri otomatik aşama ve tahmin kuralları tarafından kullanılır. */
export const DEFAULT_STAGES: StageDef[] = [
  { id: "idea", label: "Fikir", color: "#8a8fa3" },
  { id: "processed", label: "İşlendi", color: "#a78bfa" },
  { id: "writing", label: "Script yazılıyor", color: "#f5b84b" },
  { id: "ready", label: "Script hazır", color: "#4fd1a5" },
  { id: "filmed", label: "Çekildi", color: "#f0883e" },
  { id: "published", label: "Yayınlandı", color: "#ef7a8c" },
];

/**
 * Eski varsayılandaki "Altyazı alındı" aşaması kaldırıldı (altyazı alınınca hemen işlenir).
 * Kullanıcı adını değiştirmediyse listeden çıkarılır; o aşamadaki projeler ilk aşamada görünür.
 */
export function migrateStages(stages: StageDef[]): StageDef[] {
  const next = stages.filter((s) => !(s.id === "subs" && s.label === "Altyazı alındı"));
  return next.length ? next : DEFAULT_STAGES;
}

/** Uygulamanın varsayılan ayarları (ilk açılış ve "varsayılana dön" düğmeleri). */
export const DEFAULT_SETTINGS: Settings = {
  baseUrl: "https://api.openai.com/v1",
  model: "",
  insightModel: "",
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  insightPrompt: DEFAULT_INSIGHT_PROMPT,
  uiFont: "Inter",
  readFont: "Source Serif 4",
  writeFont: "Literata",
  fontSize: 17,
  lineHeight: 1.75,
  textWidth: 720,
  splitRatio: 0.5,
  splitLeft: 0.36,
  splitMid: 0.26,
  segmentTint: 0.12,
  chunkChars: 6000,
  lastProjectId: "",
  sttLanguage: "",
  sttEngine: "groq",
  whisperModel: "large-v3-turbo-q5_0",
  cookiesBrowser: "",
  stages: DEFAULT_STAGES,
  defaultChecklist: ["Kaynakları izle", "Taslak yaz", "Gözden geçir", "Çekim", "Thumbnail", "Yükle"],
  autoStage: true,
  statsSource: "ytdlp",
  homeSort: "updated",
  voiceDeviceId: "",
  voiceNoiseSuppression: true,
  voiceEchoCancel: false,
  voiceAutoGain: false,
  voiceLanguage: "",
  voiceAutoTranscribe: true,
  voiceGapMs: 300,
  voiceCountdown: 0,
  voiceKeys: {},
};

/** Ses kaydı kısayollarının varsayılanları. */
export const DEFAULT_VOICE_KEYS: Record<VoiceKeyAction, string> = {
  toggle: "Ctrl+Shift+M",
  record: "R",
  finish: "Enter",
  cancel: "Escape",
  pause: "Space",
  play: "Space",
  rerecord: "Shift+R",
  remove: "Delete",
};

/** Etkin kısayollar: kullanıcının değiştirdikleri + varsayılanlar. */
export function voiceKeys(s: Pick<Settings, "voiceKeys">): Record<VoiceKeyAction, string> {
  return { ...DEFAULT_VOICE_KEYS, ...(s.voiceKeys ?? {}) };
}
