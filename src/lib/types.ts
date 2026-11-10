/** Bir cümlenin orijinal videodaki başlangıcı: paragraf sırası, paragraf içi karakter konumu, saniye. */
export interface SentenceMark {
  para: number;
  start: number;
  t: number;
}

export interface Segment {
  id: string;
  title: string;
  text: string; // paragraflar boş satırla ayrılır
  marks?: SentenceMark[]; // cümle zamanları (AI zaman işaretlerinden); yoksa orijinal ses çalınmaz
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
  /** Kesim listesi tercihleri: sessizlik eşiği (sn) ve kullanıcının varsayılanı değiştirdiği öneri kimlikleri */
  cuts?: { silenceSec?: number; off?: string[]; on?: string[] };
}

/** Kaynak metin hakkında AI ile sohbet mesajı. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  model?: string; // yanıtı üreten model (yalnız assistant)
  quote?: string; // soruya eklenen seçili metin (yalnız user)
  createdAt: number;
}

/** Yeniden işlemeden önceki sürüm: geri dönmek için saklanır. */
export interface HistoryEntry {
  segments: Segment[];
  insights: Insight[];
  createdAt: number; // bu sürümün üretildiği an
  label: string;
}

/** Bir projedeki kaynak video: kendi altyazısı, işlenmiş bölümleri ve açıklamaları vardır. */
export interface Source {
  id: string;
  url: string;
  title: string;
  transcriptRaw: string;
  segments: Segment[];
  insights: Insight[];
  createdAt: number;
  /** Güncel sürümün üretim zamanı ve açıklaması (geçmişe girerken kullanılır). */
  processedAt?: number;
  procLabel?: string;
  history?: HistoryEntry[]; // en yeni başta, en çok 3
  /** Bu kaynak metin hakkında AI ile yapılan sohbet. */
  chat?: ChatMessage[];
}

export interface Project {
  id: string;
  title: string;
  url: string; // diskte her zaman ilk kaynağın bağlantısı (proje listesi için)
  createdAt: number;
  updatedAt: number;
  sources: Source[];
  activeSourceId: string;
  editorDoc: any | null; // TipTap JSON
  timed?: TimedDoc | null;
  imageMeta: Record<string, ImageMeta>;
  /** Ana aşama (Settings.stages içindeki kimlik). */
  stage?: string;
  checklist?: CheckItem[];
  note?: string;
  pinned?: boolean;
  archived?: boolean;
}

export interface CheckItem {
  id: string;
  text: string;
  done: boolean;
}

export interface StageDef {
  id: string;
  label: string;
  color: string;
}

/** Arka plan işleminin (altyazı çekme / AI) anlık durumu; tek seferde tek işlem çalışır. */
export interface ProcState {
  running: boolean;
  phase: "transcript" | "subs" | "ai" | null;
  progress: { done: number; total: number } | null;
  error: string | null;
  live: Segment[] | null;
  /** İşlemin ait olduğu kaynak (sekme değişse de sonuç buraya yazılır). */
  sourceId: string | null;
  /** Hata sonrası kaldığı yerden devam edilebilir mi? */
  resumable: boolean;
}

export interface ProjectMeta {
  id: string;
  title: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  stage: string;
  checkDone: number;
  checkTotal: number;
  checklist: CheckItem[];
  note: string;
  pinned: boolean;
  archived: boolean;
  /** Kart için tüm video bağlantıları. */
  sources: { url: string; title: string }[];
}

/** Bir videonun izlenme vb. istatistikleri (yt-dlp ya da YouTube API'den; video-stats.json önbelleği). */
export interface VideoStat {
  id: string;
  title: string;
  channel: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  duration: number; // sn; 0 = bilinmiyor
  uploadedAt: number; // ms; 0 = bilinmiyor
  fetchedAt: number;
  history: { t: number; views: number }[];
}

export type HomeSort = "updated" | "views" | "stage" | "created";
export type StatsSource = "ytdlp" | "api" | "auto";

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
  /** Video açıkken üç bölmeli düzen: sol ve orta panelin genişlik oranları (kalan sağ panel). */
  splitLeft: number;
  splitMid: number;
  segmentTint: number;
  chunkChars: number;
  lastProjectId: string;
  sttLanguage: string; // Groq ses→yazı dili (boşsa otomatik)
  cookiesBrowser: string; // yt-dlp çerez kaynağı: "" (yok) veya "firefox"
  stages: StageDef[];
  defaultChecklist: string[];
  autoStage: boolean;
  statsSource: StatsSource;
  homeSort: HomeSort;
}
