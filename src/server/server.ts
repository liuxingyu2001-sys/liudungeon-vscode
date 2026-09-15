/**
 * 语言服务入口：把补全 / 悬停 / 跳转 / 诊断接到 LSP 上。
 *
 * 工作区文件由客户端（扩展主进程）用 vscode.workspace.fs 读取后通过
 * `liudungeon/loadWorkspace` 通知推过来，服务端不直接碰磁盘 —— 这样
 * 远端 / 虚拟工作区（vscode.dev、Remote-SSH）也能正常工作。
 */
import {
  CompletionItem,
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

/** 用「工作区快照 + 未保存的打开文档」重建副本索引。 */
function rebuildIndex(): void {
  const merged = new Map(workspaceFiles);
  for (const doc of documents.all()) {
    merged.set(doc.uri, doc.getText());
  }
  index.rebuild(
    [...merged.entries()].map(([uri, text]) => ({ path: uriToPath(uri), text })),
  );
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
//  跳转到定义（组名 / 区域名 / 奖励名 → 定义处）
// ==================================================================

connection.onDefinition((params): Location[] | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const filePath = uriToPath(params.textDocument.uri);
  const name = baseName(filePath);
  if (!name.endsWith('.yml') && !name.endsWith('.yaml')) return null;

  const text = doc.getText();
  const lines = text.split(/\r?\n/);
  const line = lines[params.position.line] ?? '';
  const dir = index.dirForFile(filePath);
  if (!dir) return null;

  // 取光标下的词
  const wordMatch = wordAtPosition(line, params.position.character);
  if (!wordMatch) return null;
  const word = wordMatch.word;

  const kinds: RefKind[] = ['groups', 'zones', 'rewards', 'stages', 'interacts', 'tasks', 'points'];
  for (const kind of kinds) {
    const def = index.names(kind, dir).find((d) => d.name === word);
    if (def) {
      const target = index.list().find((i) => i.dir === dir);
      const file = target?.files.find((f) => baseName(f) === def.file);
      if (!file) continue;
      return [
        {
          uri: pathToFileUri(file),
          range: {
            start: { line: def.line, character: 0 },
            end: { line: def.line, character: word.length },
          },
        },
      ];
    }
  }
  return null;
});

function wordAtPosition(line: string, character: number): { word: string; start: number } | null {
  const re = /[\w\u4e00-\u9fa5.@-]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (character >= m.index && character <= m.index + m[0].length) {
      return { word: m[0], start: m.index };
    }
  }
  return null;
}

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
