/** 生成 liudungeon.d.ts（被 scripts/gen-dts-check.mjs 打包执行）。 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildDts } from './dts';

export default function generateDts(outPath = '.liudungeon/liudungeon.d.ts'): string {
  const text = buildDts();
  if (outPath) {
    mkdirSync(outPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
    writeFileSync(outPath, text, 'utf-8');
  }
  return text;
}
