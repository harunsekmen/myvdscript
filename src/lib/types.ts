export interface Segment {
  id: string;
  title: string;
  text: string; // paragraflar boş satırla ayrılır
}

export interface InsightResult {
  id: string;
  model: string;
  text: string;
  createdAt: number;
}

export interface Insight {
  id: string;
  segmentId: string;
  para: number; // segment içindeki paragraf sırası
  start: number; // paragraf içi karakter offseti
  end: number;
  quote: string;
  results: InsightResult[];
}

export interface ImageMeta {
  name: string;
  note: string;
}

/** Kelime kelime zamanlı altyazı: sırayla kelimeler, satır sonları, notlar ve resimler. */
export type TimedItem =
  | { k: "w"; id: string; w: string; s: number; e: number } // kelime, başlangıç/bitiş (sn)
  | { k: "br" } // satır sonu
  | { k: "note"; id: string; text: string } // yazarın notu
  | { k: "img"; id: string; path: string; name: string }; // resim

export interface TimedDoc {
  source: string; // kaynak dosya adı
  lang: string; // algılanan dil
  items: TimedItem[];
  /** AI'ın önerdiği düzeltmeler: kelime kimliği → önerilen metin (onaylanana kadar bekler) */
  suggestions?: Record<string, string>;
}

export interface Project {
  id: string;
  title: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  transcriptRaw: string;
  segments: Segment[];
  insights: Insight[];
  editorDoc: any | null; // TipTap JSON
  timed?: TimedDoc | null;
  imageMeta: Record<string, ImageMeta>;
}

export interface ProjectMeta {
  id: string;
  title: string;
  url: string;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  baseUrl: string;
  model: string;
  insightModel: string;
  temperature: number;
  systemPrompt: string;
  insightPrompt: string;
  uiFont: string;
  readFont: string;
  writeFont: string;
  fontSize: number;
  lineHeight: number;
  textWidth: number;
  splitRatio: number;
  segmentTint: number;
  chunkChars: number;
  lastProjectId: string;
  sttLanguage: string; // Groq ses→yazı dili (boşsa otomatik)
}
