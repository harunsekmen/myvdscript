import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const translation = "### [KONU: Proje doğrulaması]\n[00:05] Bir kaynak iddiası. [00:25] İkinci zamanlı cümle.";
const synthesis = "## Kaynak sentezi doğrulaması\nSenaryo metni [K1 00:05]. İkinci kaynak [K2 00:25].";
const publishing = {
  titles: Array.from({ length: 5 }, (_, index) => `Başlık ${index + 1}`),
  description: "Kısa açıklama.",
  tags: Array.from({ length: 10 }, (_, index) => `etiket ${index + 1}`),
  pinnedComment: "Siz nasıl kullanıyorsunuz?",
};

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const system = input.messages?.[0]?.content ?? "";
    const type = system.includes("video senaryosu editörüsün") ? "synthesis" : system.includes("yayın üretimine") ? "publish" : "translation";
    const content = type === "synthesis" ? synthesis : type === "publish" ? JSON.stringify(publishing) : translation;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url?.endsWith("models") ? { data: [{ id: "smoke" }] } : { choices: [{ message: { content } }] }));
  } catch {
    res.statusCode = 400;
    res.end();
  }
});
await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const debugPort = 13947;
const child = spawn(process.argv[2], [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    WEBVIEW2_USER_DATA_FOLDER: join(tmpdir(), "script-atolyesi-smoke-webview"),
  },
  stdio: ["ignore", "inherit", "inherit"],
});

async function wait(label, callback, { timeout = 50_000 } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (; Date.now() < until; await sleep(220)) {
    try {
      const found = await callback();
      if (found) return found;
    } catch (error) { last = error; }
  }
  throw new Error(`Waiting for ${label}${last ? `: ${last.message}` : ""}`);
}

let socket;
try {
  const tab = await wait("WebView2 page", async () => {
    if (child.exitCode != null) throw new Error(`app exited with code ${child.exitCode}`);
    const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
    return list.find((target) => target.type === "page" && target.url.includes("tauri.localhost"));
  });
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) pending.get(message.id)?.(message);
  });
  const evalPage = async (expression) => {
    const requestId = ++id;
    const result = await new Promise((resolve, reject) => {
      const limit = setTimeout(() => { pending.delete(requestId); reject(new Error("CDP evaluation timeout")); }, 10_000);
      pending.set(requestId, (reply) => { clearTimeout(limit); pending.delete(requestId); resolve(reply); });
      socket.send(JSON.stringify({ id: requestId, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (result.error || result.result.exceptionDetails) throw new Error(result.error?.message || result.result.exceptionDetails.exception?.description);
    return result.result.result.value;
  };
  const invoke = (command, args) => evalPage(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})})`);
  const text = (expected) => evalPage(`document.body.innerText.includes(${JSON.stringify(expected)})`);
  const click = (expected) => evalPage(`(() => {
    const b = [...document.querySelectorAll('button')].find((button) => !button.disabled && button.innerText.trim().replace(/\\s+/g, ' ').startsWith(${JSON.stringify(expected)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  const press = (label) => wait(label, () => click(label));
  await wait("home", () => text("Linkten başlat"));
  await invoke("save_settings", { settings: { aiProvider: "api", baseUrl: endpoint, model: "smoke", sttEngine: "local" } });
  const title = "Windows QA 0.2";
  const project = await invoke("create_project", { title, url: "" });
  const sources = [
    { id: "one", url: "", title: "Bir", transcriptRaw: "[00:05] Bir kaynak iddiası.\n[00:25] İkinci cümle.", segments: [], insights: [], createdAt: 1 },
    { id: "two", url: "", title: "İki", transcriptRaw: "[00:25] İkinci kaynak.", segments: [], insights: [], createdAt: 1 },
  ];
  await invoke("save_project", { project: {
    ...project, sources, activeSourceId: "one", editorDoc: {
      type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Windows veri testi." }] }],
    },
  } });
  await evalPage("setTimeout(() => location.reload(), 50); true");
  await wait("test project on home", () => text(title));
  await wait("open fixture", () => evalPage(`(() => {
    const card = [...document.querySelectorAll('.kcard')].find((node) => node.textContent.includes(${JSON.stringify(title)}));
    if (!card) return false;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`));
  await press("Yeniden işle");
  await press("Yeniden işle Varsayılan");
  await wait("translated source", () => text("İkinci zamanlı cümle."));
  console.log("Windows transcript processing and rendering verified");

  await wait("factcheck action", async () => {
    if (await text("İddiayı doğrula")) return true;
    return evalPage(`(() => {
      const p = document.querySelector('p[data-para]');
      if (!p) return false;
      const range = document.createRange();
      range.selectNodeContents(p);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
      p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return false;
    })()`);
  });
  await wait("run API factcheck", () => evalPage(`(() => {
    const b = [...document.querySelectorAll('button')].find((item) => item.innerText.includes('İddiayı doğrula'));
    if (!b) return false;
    b.click();
    return true;
  })()`));
  await wait("unverified factcheck", () => text("Doğrulanamadı"));
  console.log("Windows factcheck fallback and card verified");

  await press("Sentez");
  await press("Sentezle");
  await wait("synthesis", () => text("Kaynak sentezi doğrulaması"));
  await press("Editöre aktar");
  await wait("inserted script", () => evalPage(`document.querySelector('.tiptap')?.innerText.includes('Senaryo metni.')`));
  await press("Yayın");
  await press("Yayın bilgilerini üret");
  const loaded = await wait("saved publishing data", async () => {
    const data = await invoke("load_project", { id: project.id });
    return data.publish?.tags?.length === 10 ? data : null;
  });
  assert.equal(loaded.publish.titles.length, 5);
  assert.equal(loaded.syntheses[0].citations.length, 2);
  assert.equal(loaded.sources[0].insights[0].results[0].verdict, "unverified");
  assert.match(JSON.stringify(loaded.editorDoc), /Kaynak sentezi doğrulaması/);
  const backup = await invoke("list_backups", { projectId: project.id });
  assert.equal(backup.length, 1);
  console.log("Windows synthesis, editor insertion, publish and daily backup verified");
} finally {
  socket?.close();
  child.kill();
  server.close();
}
