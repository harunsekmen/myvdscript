import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const resultPath = join(process.env.RUNNER_TEMP || tmpdir(), "script-atolyesi-windows-smoke.json");
if (process.argv[2] === "prepare") {
  const code = readFileSync(new URL("./windows-smoke-scenario.js", import.meta.url), "utf8");
  const overlay = "src/_windows_smoke.generated.ts";
  if (existsSync(overlay)) throw new Error("Windows smoke overlay already exists");
  writeFileSync(overlay, `// @ts-nocheck\nconst resultPath = ${JSON.stringify(resultPath)};\n${code}\nexport {};\n`, { flag: "wx" });
  appendFileSync("src/main.tsx", '\nimport "./_windows_smoke.generated";\n');
  process.exit(0);
}

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
await new Promise((resolve, reject) => server.once("error", reject).listen(13947, "127.0.0.1", resolve));
const child = spawn(process.argv[2], [], {
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(tmpdir(), "script-atolyesi-smoke-webview") },
  stdio: ["ignore", "inherit", "inherit"],
});
try {
  let last = "";
  const stop = Date.now() + 110_000;
  while (Date.now() < stop && child.exitCode == null) {
    let update;
    try { update = JSON.parse(readFileSync(resultPath, "utf8")); } catch { /* first write can be in flight */ }
    if (update?.step === "done") {
      console.log("Windows desktop smoke verified", update.passed.join(", "));
      process.exitCode = 0;
      break;
    }
    if (update?.step === "error") throw new Error(JSON.stringify(update));
    if (update?.step && last !== update.step) {
      last = update.step;
      console.log("Windows desktop smoke reached", last);
    }
    await sleep(300);
  }
  if (process.exitCode !== 0) throw new Error(`Desktop fixture stopped at ${last || "startup"} (exit ${child.exitCode})`);
} finally {
  child.kill();
  server.close();
}
