import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/literata";

export const FONT_OPTIONS: { label: string; css: string }[] = [
  { label: "Inter", css: '"Inter Variable", "Segoe UI", sans-serif' },
  { label: "Source Serif 4", css: '"Source Serif 4 Variable", Georgia, serif' },
  { label: "Literata", css: '"Literata Variable", Georgia, serif' },
  { label: "Segoe UI", css: '"Segoe UI", sans-serif' },
  { label: "Georgia", css: "Georgia, serif" },
  { label: "Consolas", css: 'Consolas, "Cascadia Mono", monospace' },
];

export const fontCss = (label: string) => FONT_OPTIONS.find((f) => f.label === label)?.css ?? FONT_OPTIONS[0].css;
