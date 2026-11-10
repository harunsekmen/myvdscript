import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/fonts";
import "./styles.css";
import App from "./App";

// Tarayıcının sağ tık menüsü (Geri, Yenile, Farklı kaydet, Yazdır…) uygulamada gösterilmez.
// Yazı alanlarında kes/kopyala/yapıştır menüsü kalır; uygulamanın kendi sağ tık menüleri etkilenmez.
window.addEventListener(
  "contextmenu",
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input, textarea, [contenteditable="true"], [contenteditable=""]')) return;
    e.preventDefault();
  },
  { capture: true },
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
