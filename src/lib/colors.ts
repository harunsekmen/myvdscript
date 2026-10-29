// Birbirine yakın, soft ve koyu mavi-mor-yeşilimsi tonlar (hue 195–275 arası).
export function segHue(i: number): number {
  return 195 + ((i * 37) % 80);
}

export function segStyle(i: number, tint: number): { stripe: string; bg: string; label: string } {
  const h = segHue(i);
  const sat = Math.round(Math.min(45, 8 + tint * 220));
  return {
    stripe: `hsl(${h} 45% 58%)`,
    bg: `hsl(${h} ${sat}% 17%)`,
    label: `hsl(${h} 40% 68%)`,
  };
}
