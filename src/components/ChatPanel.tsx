import { activeModel, providerOptions } from "../lib/aiProvider";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { streamChat } from "../lib/api";
import { buildChatSystem, chatHistory, chatUserText } from "../lib/chat";
import type { ChatMessage, Segment, Settings } from "../lib/types";
import { Markdown } from "./Markdown";

const MODEL_KEY = "sa.chatModel";

interface Props {
  title: string;
  segments: Segment[];
  messages: ChatMessage[];
  settings: Settings;
  models: string[];
  /** Seçim balonundaki "Sor" ile eklenen alıntı. */
  quote: string | null;
  onClearQuote: () => void;
  onChange: (msgs: ChatMessage[]) => void;
  onClose: () => void;
  onToast: (msg: string, kind?: "error" | "info") => void;
}

/** Kaynak metin bağlamında, seçilen modelle çok turlu soru-cevap. */
export function ChatPanel({ title, segments, messages, settings, models, quote, onClearQuote, onChange, onClose, onToast }: Props) {
  const fallback = activeModel(settings, true);
  const [model, setModel] = useState(() => localStorage.getItem(`${MODEL_KEY}.${settings.aiProvider}`) || (settings.aiProvider === "api" ? localStorage.getItem(MODEL_KEY) : "") || fallback);
  const [input, setInput] = useState("");
  const [live, setLive] = useState<{ text: string; error?: string } | null>(null);
  const runRef = useRef<{ cancel: () => void } | null>(null);
  const msgsRef = useRef(messages);
  msgsRef.current = messages;
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);

  // Panel kapanır ya da kaynak değişirse akış durur; o ana kadar gelen yanıt kaybolmasın diye kaydedilir.
  const liveRef = useRef(live);
  liveRef.current = live;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const modelRef = useRef(model || fallback);
  modelRef.current = model || fallback;
  useEffect(
    () => () => {
      if (!runRef.current) return;
      runRef.current.cancel();
      const partial = liveRef.current && !liveRef.current.error ? liveRef.current.text.trim() : "";
      if (partial) {
        onChangeRef.current([
          ...msgsRef.current,
          { id: crypto.randomUUID(), role: "assistant", text: partial + " …", model: modelRef.current, createdAt: Date.now() },
        ]);
      }
    },
    [],
  );
  useEffect(() => {
    if (quote) inputRef.current?.focus();
  }, [quote]);
  // Yeni yanıt gelmeye başlayınca yanıtın başına yumuşakça kaydırılır; sonra akış sırasında aşağı çekilmez,
  // böylece uzun yanıt baştan okunabilir. (Soru gönderilince alta inilir ki soru ve "bekleniyor" görünsün.)
  const jumpRef = useRef(false);
  const liveElRef = useRef<HTMLDivElement>(null);
  // Yumuşak kaydırma sürerken kaydırma olayları "altta kal" kararını değiştirmesin (animasyon yarıda kesilmesin)
  const jumpingUntil = useRef(0);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (jumpRef.current) {
      const lastMsg = msgsRef.current[msgsRef.current.length - 1];
      const target = live
        ? live.text && !live.error
          ? liveElRef.current
          : null
        : lastMsg?.role === "assistant"
          ? (el.querySelector(".chat-msg:last-of-type") as HTMLElement | null)
          : null;
      if (target) {
        jumpRef.current = false;
        stickRef.current = false;
        jumpingUntil.current = Date.now() + 800;
        const top = el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
        el.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        return;
      }
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  const pickModel = (m: string) => {
    setModel(m);
    localStorage.setItem(`${MODEL_KEY}.${settings.aiProvider}`, m);
  };

  const busy = !!live && !live.error;

  /** `before` önceki mesajlar, `ask` cevaplanacak kullanıcı mesajı (listede zaten var). */
  const run = (before: ChatMessage[], ask: ChatMessage) => {
    const useModel = model || fallback;
    if (!useModel) return onToast("Önce Ayarlar'dan bir model seçin", "error");
    runRef.current?.cancel();
    stickRef.current = true;
    jumpRef.current = true;
    const h = streamChat({
      ...providerOptions(settings, { insight: true, model: useModel }),
      system: buildChatSystem(title, segments),
      history: chatHistory(before),
      user: chatUserText(ask),
      onText: (t) => setLive({ text: t }),
    });
    runRef.current = h;
    setLive({ text: "" });
    h.done
      .then((text) => {
        runRef.current = null;
        setLive(null);
        const res: ChatMessage = { id: crypto.randomUUID(), role: "assistant", text: text.trim(), model: useModel, createdAt: Date.now() };
        onChange([...msgsRef.current, res]);
      })
      .catch((e) => {
        if (e.message === "İptal edildi") return;
        runRef.current = null;
        setLive({ text: "", error: e.message });
      });
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    const ask: ChatMessage = { id: crypto.randomUUID(), role: "user", text, quote: quote ?? undefined, createdAt: Date.now() };
    const before = msgsRef.current;
    onChange([...before, ask]);
    msgsRef.current = [...before, ask];
    setInput("");
    onClearQuote();
    run(before, ask);
  };

  const stop = () => {
    const partial = live?.text.trim();
    runRef.current?.cancel();
    runRef.current = null;
    setLive(null);
    // Yarıda kesilen yanıtın gelen kısmı kaybolmasın.
    if (partial) onChange([...msgsRef.current, { id: crypto.randomUUID(), role: "assistant", text: partial + " …", model, createdAt: Date.now() }]);
  };

  // Son kullanıcı sorusunu (sonrasındaki yanıt silinerek) yeniden sorar.
  const lastAsk = [...messages].reverse().find((m) => m.role === "user");
  const retry = () => {
    if (!lastAsk || busy) return;
    const i = messages.lastIndexOf(lastAsk);
    const kept = messages.slice(0, i + 1);
    onChange(kept);
    msgsRef.current = kept;
    run(messages.slice(0, i), lastAsk);
  };

  const clear = () => {
    runRef.current?.cancel();
    setLive(null);
    onChange([]);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast("Kopyalandı", "info");
    } catch {
      onToast("Kopyalanamadı", "error");
    }
  };

  const modelOptions = Array.from(new Set([model, fallback, ...models].filter(Boolean)));
  const last = messages[messages.length - 1];

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span className="chat-title">AI'a sor</span>
        <select className="input small chat-model" value={model} onChange={(e) => pickModel(e.target.value)} title="Sohbet modeli">
          {!model && <option value="">(model seçin)</option>}
          {modelOptions.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <button className="icon-btn" onClick={clear} disabled={!messages.length && !live} title="Sohbeti temizle">
          Temizle
        </button>
        <button className="icon-btn" onClick={onClose} title="Kapat">✕</button>
      </div>
      <div
        className="chat-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (Date.now() < jumpingUntil.current) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!messages.length && !live && (
          <div className="chat-empty muted">
            Bu metin hakkında merak ettiğini sor. Kaynak metnin tamamı bağlam olarak gönderilir; metinde bir yeri seçip <b>Sor</b> diyerek alıntıyla da soru sorabilirsin.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={"chat-msg " + m.role}>
            {m.quote && <div className="chat-quote">“{m.quote}”</div>}
            {m.role === "assistant" ? <Markdown text={m.text} /> : <div className="chat-text">{m.text}</div>}
            {m.role === "assistant" && (
              <div className="chat-meta">
                <span>{m.model}</span>
                <button className="icon-btn" onClick={() => copy(m.text)} title="Yanıtı kopyala">Kopyala</button>
                {m === last && !busy && (
                  <button className="icon-btn" onClick={retry} title="Aynı soruyu yeniden sor">↻ Yeniden</button>
                )}
              </div>
            )}
          </div>
        ))}
        {live && (
          <div className="chat-msg assistant" ref={liveElRef}>
            {live.error ? (
              <div className="banner error">
                <span>{live.error}</span>
                <button className="btn small" onClick={retry}>Tekrar dene</button>
              </div>
            ) : live.text ? (
              <>
                <Markdown text={live.text} />
                <span className="caret" />
              </>
            ) : (
              <div className="muted">Yanıt bekleniyor… <span className="caret" /></div>
            )}
          </div>
        )}
      </div>
      {quote && (
        <div className="chat-pending">
          <span title={quote}>“{quote}”</span>
          <button className="icon-btn" onClick={onClearQuote} title="Alıntıyı kaldır">✕</button>
        </div>
      )}
      <div className="chat-input">
        <textarea
          ref={inputRef}
          className="input"
          rows={2}
          placeholder="Sorunu yaz… (Enter gönderir, Shift+Enter yeni satır)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button className="btn small" onClick={stop} title="Yanıtı durdur">Durdur</button>
        ) : (
          <button className="btn primary small" onClick={send} disabled={!input.trim()}>Gönder</button>
        )}
      </div>
    </div>
  );
}
