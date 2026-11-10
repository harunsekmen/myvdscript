import { describe, expect, it } from "vitest";
import { buildChatSystem, chatHistory, chatUserText, sourceContext } from "./chat";
import type { ChatMessage } from "./types";

const seg = (title: string, text: string) => ({ id: title, title, text });

describe("sohbet bağlamı", () => {
  it("bölümleri başlıklarıyla birleştirir", () => {
    const c = sourceContext([seg("Giriş", "Merhaba."), seg("Son", "Bitti.")]);
    expect(c).toBe("## Giriş\n\nMerhaba.\n\n## Son\n\nBitti.");
  });

  it("uzun metni ortadan kırpar", () => {
    const c = sourceContext([seg("", "a".repeat(500) + "b".repeat(500))], 100);
    expect(c.startsWith("a".repeat(60))).toBe(true);
    expect(c.endsWith("b".repeat(40))).toBe(true);
    expect(c).toContain("çıkarıldı");
  });

  it("sistem istemine başlık ve metni ekler", () => {
    const s = buildChatSystem("Video", [seg("A", "metin")]);
    expect(s).toContain("Video başlığı: Video");
    expect(s).toContain("## A\n\nmetin");
  });

  it("alıntılı soruyu ve geçmişi kurar", () => {
    expect(chatUserText({ text: "Bu ne?", quote: "x\ny" })).toBe("Metinden alıntı:\n> x y\n\nBu ne?");
    const msgs: ChatMessage[] = [
      { id: "1", role: "user", text: "s1", createdAt: 0 },
      { id: "2", role: "assistant", text: "", createdAt: 0 },
      { id: "3", role: "assistant", text: "y1", createdAt: 0 },
    ];
    expect(chatHistory(msgs)).toEqual([
      { role: "user", content: "s1" },
      { role: "assistant", content: "y1" },
    ]);
    expect(chatHistory(msgs, 1)).toEqual([{ role: "assistant", content: "y1" }]);
  });
});
