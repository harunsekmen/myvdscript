import { Node, mergeAttributes } from "@tiptap/core";

/** Metin akışına gömülen resim "chip"i (atom, satır içi). */
export const ImageChip = Node.create({
  name: "imageChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      path: { default: "" },
      name: { default: "resim" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-image-chip]" }];
  },

  renderHTML({ node }) {
    return [
      "span",
      mergeAttributes({ "data-image-chip": "", class: "image-chip", title: node.attrs.path }),
      ["span", { class: "chip-ico" }],
      node.attrs.name,
    ];
  },
});

const MAX_SIDE = 2000;
const MAX_BYTES = 4 * 1024 * 1024;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

/** Büyük resimleri küçültür; (base64, uzantı) döndürür. */
export async function prepareImage(file: File): Promise<{ data: string; ext: string }> {
  const src = await readAsDataUrl(file);
  const mime = file.type || "image/png";
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("Resim okunamadı"));
    img.src = src;
  });
  const big = Math.max(img.width, img.height) > MAX_SIDE;
  if (!big && file.size <= MAX_BYTES) return { data: src, ext };
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpeg = ext === "jpg";
  return { data: canvas.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.9), ext: jpeg ? "jpg" : "png" };
}
