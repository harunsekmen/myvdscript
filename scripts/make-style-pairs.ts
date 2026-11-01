// Kullanım: node scripts/make-style-pairs.ts <kaynak.vtt|srt> <çeviri.srt> > pairs.json
// Kaynak ve çeviri altyazılarını zamana göre hizalayıp örnek çifti adaylarını JSON olarak yazar.
import { readFileSync } from "node:fs";
import { makeStylePairs } from "../src/lib/styleAlign.ts";

const [sourcePath, targetPath] = process.argv.slice(2);
if (!sourcePath || !targetPath) {
  console.error("Kullanım: node scripts/make-style-pairs.ts <kaynak> <çeviri>");
  process.exit(1);
}
const pairs = makeStylePairs(readFileSync(sourcePath, "utf8"), readFileSync(targetPath, "utf8"));
process.stdout.write(JSON.stringify(pairs, null, 2));
