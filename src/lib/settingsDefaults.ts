import { DEFAULT_INSIGHT_PROMPT, DEFAULT_SYSTEM_PROMPT } from "./prompts";
import type { Settings } from "./types";

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
  cookiesBrowser: "",
};
