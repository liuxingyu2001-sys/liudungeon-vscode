/**
 * 语言服务入口：把补全 / 悬停 / 跳转 / 诊断接到 LSP 上。
 *
 * 工作区文件由客户端（扩展主进程）用 vscode.workspace.fs 读取后通过
 * `liudungeon/loadWorkspace` 通知推过来，服务端不直接碰磁盘 —— 这样
 * 远端 / 虚拟工作区（vscode.dev、Remote-SSH）也能正常工作。
 */
import {
  CodeAction,
  CompletionItem,
  Diagnostic,
  Range,
  createConnection,
  DidChangeConfigurationNotification,
  DocumentSymbol,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  ProposedFeatures,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

import { provideCompletions } from './completion';
import { computeDiagnostics, type DiagnosticsOptions } from './diagnostics';
import { IndexStore, baseName, REF_LABEL, type RefKind } from './index-store';
import { provideHover } from './hover';
import { provideCodeActions } from './code-actions';
import {
  findReferences,
  symbolAt,
  toLocation,
  type RefHit,
  type SymbolAtCursor,
} from './references';

const connection = createConnection(ProposedFeatures.all);

// 任何未捕获的异常都打到 stderr（VS Code 会收进输出面板），否则排错时只看到「没反应」
process.on('uncaughtException', (err) => {
  console.error('[liudungeon-ls] 未捕获异常:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[liudungeon-ls] 未处理的 Promise 拒绝:', err);
});
const documents = new TextDocuments(TextDocument);
const index = new IndexStore();

/** 工作区文件快照：绝对路径（file:// URI 字符串）→ 文本。 */
const workspaceFiles = new Map<string, string>();

let options: DiagnosticsOptions = {
  unknownMethod: true,
  references: true,
  knownHooks: true,
};

let diagnosticsEnabled = true;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const caps = params.capabilities;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        // 只在真正需要重新拉列表的字符上触发；空格/冒号手动 Ctrl+空格即可，
        // 否则每敲一个空格都会发起一次补全请求。
        triggerCharacters: ['.', '@', '{', "'", '"'],
      },
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: {
        codeActionKinds: ['quickfix'],
      },
      workspace: {
        workspaceFolders: { supported: true },
      },
    },
  };
  void caps;
});

connection.onInitialized(() => {
  connection.client.register(DidChangeConfigurationNotification.type, undefined);
});

// ==================================================================
//  配置
// ==================================================================

interface Settings {
  enable?: boolean;
  diagnostics?: {
    enable?: boolean;
    unknownMethod?: boolean;
    references?: boolean;
    knownHooks?: boolean;
  };
}

async function pullSettings(): Promise<void> {
  try {
    const s = (await connection.workspace.getConfiguration('liudungeon')) as Settings;
    diagnosticsEnabled = s?.enable !== false && s?.diagnostics?.enable !== false;
    options = {
      unknownMethod: s?.diagnostics?.unknownMethod !== false,
      references: s?.diagnostics?.references !== false,
      knownHooks: s?.diagnostics?.knownHooks !== false,
    };
    await refreshAllDiagnostics();
  } catch {
    // 取不到配置时沿用默认值
  }
}

connection.onDidChangeConfiguration(() => {
  void pullSettings();
});

// ==================================================================
//  工作区文件同步（客户端主动推送）
// ==================================================================

interface WorkspacePayload {
  files: Array<{ uri: string; text: string }>;
}

connection.onNotification('liudungeon/loadWorkspace', (payload: WorkspacePayload) => {
  workspaceFiles.clear();
  for (const f of payload?.files ?? []) {
    workspaceFiles.set(f.uri, f.text);
  }
  rebuildIndex();
});

connection.onNotification('liudungeon/fileChanged', (payload: { uri: string; text: string }) => {
  if (!payload?.uri) return;
  workspaceFiles.set(payload.uri, payload.text);
  rebuildIndex();
});

connection.onNotification('liudungeon/fileDeleted', (payload: { uri: string }) => {
  if (!payload?.uri) return;
  workspaceFiles.delete(payload.uri);
  rebuildIndex();
});

/** 工作区快照 + 未保存的打开文档（引用查找与索引共用同一份数据）。 */
function snapshotFiles(): Array<{ path: string; text: string }> {
  const merged = new Map(workspaceFiles);
  for (const doc of documents.all()) {
    merged.set(doc.uri, doc.getText());
  }
  return [...merged.entries()].map(([uri, text]) => ({ path: uriToPath(uri), text }));
}

/** 用「工作区快照 + 未保存的打开文档」重建副本索引。 */
function rebuildIndex(): void {
  index.rebuild(snapshotFiles());
  void refreshAllDiagnostics();
}

function uriToPath(uri: string): string {
  try {
    return URI.parse(uri).fsPath;
  } catch {
    return uri;
  }
}

function pathToFileUri(filePath: string): string {
  return URI.file(filePath).toString();
}

// ==================================================================
//  补全
// ==================================================================

connection.onCompletion((params): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const filePath = uriToPath(params.textDocument.uri);
  return provideCompletions({
    filePath,
    text: doc.getText(),
    line: params.position.line,
    character: params.position.character,
    index,
  });
});

// ==================================================================
//  悬停
// ==================================================================

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const filePath = uriToPath(params.textDocument.uri);
  const hover = provideHover({
    filePath,
    text: doc.getText(),
    line: params.position.line,
    character: params.position.character,
    index,
  });
  return hover;
});

// ==================================================================
//  符号：跳转定义 / 查找引用 / 同词高亮 / 重命名
// ==================================================================

/** 在光标位置解析出符号。 */
function symbolHere(uri: string, position: { line: number; character: number }): SymbolAtCursor | null {
  const doc = documents.get(uri);
  if (!doc) return null;
  const filePath = uriToPath(uri);
  return symbolAt(index, filePath, doc.getText().split(/\r?\n/), position);
}

/** 找出该符号的全部引用（含定义），并补上 URI。 */
function referencesHere(uri: string, position: { line: number; character: number }): {
  symbol: SymbolAtCursor;
  hits: RefHit[];
} | null {
  const symbol = symbolHere(uri, position);
  if (!symbol) return null;
  const hits = findReferences(index, snapshotFiles(), symbol.dir, symbol.kind, symbol.name).map(
    (h) => ({ ...h, uri: h.uri || pathToFileUri(h.file) }),
  );
  return { symbol, hits };
}

connection.onDefinition((params): Location[] | null => {
  const found = referencesHere(params.textDocument.uri, params.position);
  if (!found) return null;
  const def = found.hits.find((h) => h.isDefinition);
  // 优先跳到定义；找不到定义（引用写错了名字）时至少给第一个引用，避免"点了没反应"
  return [toLocation(def ?? found.hits[0])];
});

connection.onReferences((params): Location[] => {
  const found = referencesHere(params.textDocument.uri, params.position);
  if (!found) return [];
  return found.hits
    .filter((h) => params.context.includeDeclaration || !h.isDefinition)
    .map(toLocation);
});

connection.onDocumentHighlight((params) => {
  const found = referencesHere(params.textDocument.uri, params.position);
  if (!found) return [];
  const thisFile = uriToPath(params.textDocument.uri);
  return found.hits
    .filter((h) => h.file === thisFile)
    .map((h) => ({
      range: {
        start: { line: h.line, character: h.start },
        end: { line: h.line, character: h.start + h.length },
      },
      kind: h.isDefinition ? 3 : 2, // 3 = Write（定义处），2 = Read（引用处）
    }));
});

connection.onPrepareRename((params) => {
  const symbol = symbolHere(params.textDocument.uri, params.position);
  if (!symbol) return null;
  if (!isRenameable(symbol.name)) {
    return null;
  }
  return { range: symbol.range, placeholder: symbol.name };
});

connection.onRenameRequest((params) => {
  const found = referencesHere(params.textDocument.uri, params.position);
  if (!found) return null;
  if (!isRenameable(params.newName)) {
    throw new Error('名字不能含空格、点号、冒号或路径分隔符（与编辑器/解析器的命名规则一致）');
  }

  const changes: Record<string, Array<{ range: Range; newText: string }>> = {};
  for (const hit of found.hits) {
    if (hit.isDefinition) continue; // 定义处由下面的"键名替换"统一处理
    const list = (changes[hit.uri] ??= []);
    list.push({
      range: {
        start: { line: hit.line, character: hit.start },
        end: { line: hit.line, character: hit.start + hit.length },
      },
      newText: params.newName,
    });
  }

  // 定义处：把「组名/区域名」这个键本身改掉
  const defFile = index
    .list()
    .find((i) => i.dir === found.symbol.dir)
    ?.files.find((f) => baseName(f) === REF_DEFINITION_FILE[found.symbol.kind]);
  const def = found.hits.find((h) => h.isDefinition);
  if (def && defFile) {
    const defUri = pathToFileUri(defFile);
    const list = (changes[defUri] ??= []);
    // 定义行的形如 `  <名字>:`，键名从行首缩进之后开始
    const text = documents.get(defUri)?.getText() ?? workspaceFiles.get(defUri) ?? '';
    const lineText = text.split(/\r?\n/)[def.line] ?? '';
    const indent = lineText.length - lineText.trimStart().length;
    const quoted = /^['"]/.test(lineText.trimStart());
    const nameInLine = lineText.indexOf(found.symbol.name, indent);
    if (nameInLine >= 0) {
      list.push({
        range: {
          start: { line: def.line, character: nameInLine },
          end: { line: def.line, character: nameInLine + found.symbol.name.length },
        },
        newText: quoted ? `'${params.newName}'` : params.newName,
      });
    }
  }

  return { changes };
});

/** 定义每种符号的文件（重命名时要知道去哪改键名）。 */
const REF_DEFINITION_FILE: Record<string, string> = {
  groups: 'monsters.yml',
  zones: 'zones.yml',
  interacts: 'interacts.yml',
  stages: 'stages.yml',
  tasks: 'tasks.yml',
  rewards: 'rewards.yml',
  points: 'zones.yml',
};

/** 名字合法性：与编辑器 / 解析器的规则一致（不能含点号、空格、冒号、路径分隔符）。 */
function isRenameable(name: string): boolean {
  if (!name || name.trim() !== name) return false;
  if (name.length > 64) return false;
  if (/[.\s:/\\]/.test(name)) return false;
  if (name.startsWith('.')) return false;
  return true;
}

// ==================================================================
//  快速修复
// ==================================================================

connection.onCodeAction((params): CodeAction[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const actions = provideCodeActions({
    text: doc.getText(),
    diagnostics: params.context.diagnostics as Diagnostic[],
  });
  const uri = params.textDocument.uri;
  return actions.map((a) => ({
    title: a.title,
    kind: a.kind,
    diagnostics: a.diagnostics,
    isPreferred: a.isPreferred,
    edit: { changes: { [uri]: a.edits } },
    data: a.code ? { code: a.code } : undefined,
  }));
});

// ==================================================================
//  文档符号（大纲：这个文件里定义了哪些波次 / 区域 / 奖励）
// ==================================================================

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const filePath = uriToPath(params.textDocument.uri);
  const self = index.forFile(filePath);
  if (!self) return [];
  const name = baseName(filePath);
  const lines = doc.getText().split(/\r?\n/);
  const out: DocumentSymbol[] = [];
  for (const kind of Object.keys(self.defs) as RefKind[]) {
    const defs = self.defs[kind].filter((d) => d.file === name);
    const children: DocumentSymbol[] = defs.map((d) => ({
      name: d.name,
      kind: SymbolKind.Method,
      detail: d.doc ?? REF_LABEL[kind],
      range: {
        start: { line: d.line, character: 0 },
        end: { line: d.line, character: (lines[d.line] ?? '').length },
      },
      selectionRange: {
        start: { line: d.line, character: 0 },
        end: { line: d.line, character: (lines[d.line] ?? '').length },
      },
    }));
    if (!children.length) continue;
    // 容器节点行：取第一处定义所在行的上一级（近似为 0 行）
    out.push({
      name: `${REF_LABEL[kind]}（${children.length}）`,
      kind: SymbolKind.Module,
      range: {
        start: { line: children[0].range.start.line, character: 0 },
        end: { line: children[children.length - 1].range.end.line, character: 0 },
      },
      selectionRange: {
        start: { line: children[0].range.start.line, character: 0 },
        end: { line: children[0].range.start.line, character: 0 },
      },
      children,
    });
  }
  return out;
});

// ==================================================================
//  诊断
// ==================================================================

async function refreshAllDiagnostics(): Promise<void> {
  for (const doc of documents.all()) {
    await validate(doc);
  }
}

async function validate(doc: TextDocument): Promise<void> {
  const filePath = uriToPath(doc.uri);
  const name = baseName(filePath);
  const inDungeonDir = /\/(dungeons|liudungeon)\//.test(filePath);
  const isCandidate = /\.(ya?ml|js|lds)$/.test(name) && (inDungeonDir || index.dirForFile(filePath) !== undefined);
  if (!diagnosticsEnabled || !isCandidate) {
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
    return;
  }
  const diagnostics = computeDiagnostics({
    filePath,
    text: doc.getText(),
    index,
    options,
  });
  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidChangeContent((e) => {
  rebuildIndex();
  void validate(e.document);
});

documents.onDidClose((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  // 关掉的文档要从索引里移除，否则它会把磁盘上的版本钉住，
  // 同一副本目录里其它文件的引用校验会跟着一起失真。
  rebuildIndex();
});

// ==================================================================
//  启动
// ==================================================================

documents.listen(connection);
connection.listen();

// 首次连上后拉一次配置
void pullSettings();
