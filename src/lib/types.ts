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
}
