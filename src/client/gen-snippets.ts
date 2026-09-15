/** 片段生成器（被 scripts/gen-snippets.mjs 打包执行）。 */
import { buildCodeSnippets } from './code-snippets';

export default function generate(): void {
  buildCodeSnippets('snippets/liudungeon-js.code-snippets', 'snippets/liudungeon-yaml.code-snippets');
}
