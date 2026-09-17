/**
 * 扩展主进程：
 *   1. 启动语言服务（out/server/server.js），负责补全 / 悬停 / 诊断
 *   2. 把工作区里的副本配置文件读出来推给语言服务（远端工作区也能用）
 *   3. 监听文件变化，保持引用索引最新
 *   4. 生成 liudungeon.d.ts 类型声明，让 VS Code 自带的 JS 语言服务
 *      也能在 functions.js 里给出 action.* / dungeon.* 的类型提示
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { buildDts } from './dts';

let client: LanguageClient | undefined;

/** 只在这些目录下接管 yml（副本配置目录）。 */
const DUNGEON_GLOB = '**/{dungeons,liudungeon}/**/*.{yml,yaml}';

/**
 * 工作区里需要同步给语言服务的文件（与插件读取的文件名一致）。
 *
 * <p>`plugin.yml` 也是要的：它不是给用户配的，而是**判定的关键** ——
 * 插件源码里的 `src/main/resources/` 同时含有 config.yml 与 plugin.yml，
 * 那份 config.yml 是插件**主配置**（database / cross-server / statistics），
 * 不是副本配置。语言服务靠"同目录有 plugin.yml"把这两种同名文件区分开
 * （副本目录里不可能有 plugin.yml）。少了它，打开插件仓库时主配置会拿到副本的键名表。
 */
const FILE_GLOB =
  '**/{dungeons,liudungeon}/{**/config.yml,**/monsters.yml,**/scripts.yml,**/rewards.yml,**/zones.yml,**/obstacles.yml,**/interacts.yml,**/tasks.yml,**/stages.yml,**/chest_rewards.yml,**/gui.yml,**/plugin.yml,**/functions.js}';
const FALLBACK_GLOB = '**/{config,monsters,scripts,rewards,zones,interacts,tasks,stages}.yml';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('LiuDungeon');
  context.subscriptions.push(output);

  const cfg = vscode.workspace.getConfiguration('liudungeon');
  if (cfg.get<boolean>('enable') === false) {
    output.appendLine('语言服务已按配置关闭（liudungeon.enable = false）。');
    return;
  }

  // ---- 1. 语言服务 ----
  const serverModule = context.asAbsolutePath(path.join('out', 'server', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6010'] },
    },
  };

  // 只接管副本目录里的文件：不抢 redhat.vscode-yaml 对普通 yml 的补全
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'yaml', pattern: DUNGEON_GLOB },
      { scheme: 'untitled', language: 'yaml' },
      { scheme: 'file', language: 'javascript', pattern: '**/functions.js' },
      { scheme: 'untitled', language: 'javascript' },
      { scheme: 'file', language: 'liudungeon' },
      { scheme: 'vscode-remote', language: 'yaml', pattern: DUNGEON_GLOB },
      { scheme: 'vscode-remote', language: 'javascript', pattern: '**/functions.js' },
    ],
    outputChannel: output,
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/{dungeons,liudungeon}/**/*.{yml,yaml,js}'),
    },
  };

  client = new LanguageClient('liudungeon', 'LiuDungeon 脚本支持', serverOptions, clientOptions);
  await client.start();
  output.appendLine('LiuDungeon 语言服务已启动。');

  // ---- 2. 推送工作区文件 ----
  const push = async () => {
    if (!client) return;
    const files = await collectWorkspaceFiles();
    output.appendLine(`已同步 ${files.length} 个副本配置文件给语言服务。`);
    await client.sendNotification('liudungeon/loadWorkspace', { files });
  };
  await push();

  // ---- 3. 文件变化 ----
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/{dungeons,liudungeon}/**/*.{yml,yaml,js}',
  );
  const onChange = async (uri: vscode.Uri) => {
    if (!client) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf-8').decode(bytes);
      await client.sendNotification('liudungeon/fileChanged', { uri: uri.toString(), text });
    } catch {
      await client.sendNotification('liudungeon/fileDeleted', { uri: uri.toString() });
    }
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(async (uri) => {
    await client?.sendNotification('liudungeon/fileDeleted', { uri: uri.toString() });
  });
  context.subscriptions.push(watcher);

  const saveSub = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (!client) return;
    if (!/(dungeons|liudungeon)/.test(doc.uri.path)) return;
    await client.sendNotification('liudungeon/fileChanged', {
      uri: doc.uri.toString(),
      text: doc.getText(),
    });
  });
  context.subscriptions.push(saveSub);

  // ---- 4. 类型声明（给 VS Code 自带的 JS 智能提示用）----
  // 写到扩展自己的 globalStorage，绝不往工作区里丢 jsconfig.json / .liudungeon：
  // 那会在别人的仓库里留下未跟踪文件（踩过一次），而 VS Code 对 .d.ts 的自动加载
  // 本来就是全局的 —— 放哪儿都能被 JS 语言服务读到。
  const dts = await writeDts(context);
  if (dts) {
    output.appendLine(`已生成类型声明：${dts}`);
    await removeLegacyWorkspaceArtifacts();
  }

  // ---- 5. 命令 ----
  context.subscriptions.push(
    vscode.commands.registerCommand('liudungeon.reloadIndex', async () => {
      await push();
      vscode.window.showInformationMessage('LiuDungeon：副本索引已重建。');
    }),
    vscode.commands.registerCommand('liudungeon.openDocs', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '脚本开发指南（action.* / dungeon.* 全量）', file: '07-脚本开发指南.md' },
          { label: '配置文件详解（各 yml 键名）', file: '06-配置文件详解.md' },
          { label: '指令手册', file: '04-指令手册.md' },
          { label: '排错与常见问题', file: '10-排错与常见问题.md' },
          { label: '游戏内编辑模式', file: '12-游戏内编辑模式.md' },
        ],
        { title: '打开哪一章文档？' },
      );
      if (!pick) return;
      const local = vscode.Uri.joinPath(context.extensionUri, 'docs', pick.file);
      try {
        await vscode.workspace.fs.stat(local);
        await vscode.commands.executeCommand('markdown.showPreview', local);
        return;
      } catch {
        // 扩展内没带文档时给出在线地址
      }
      const folders = vscode.workspace.workspaceFolders ?? [];
      for (const folder of folders) {
        const guess = vscode.Uri.joinPath(folder.uri, 'docs', '05-使用说明', pick.file);
        try {
          await vscode.workspace.fs.stat(guess);
          await vscode.commands.executeCommand('markdown.showPreview', guess);
          return;
        } catch {
          continue;
        }
      }
      vscode.window.showWarningMessage(`没有在工作区里找到 ${pick.file}。`);
    }),
    vscode.commands.registerCommand('liudungeon.insertTemplate', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('请先打开一个配置文件或脚本文件。');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'scripts.yml：开场 + 通关结算', body: SNIPPET_SCRIPTS },
          { label: 'monsters.yml：两波（小怪 → Boss）', body: SNIPPET_MONSTERS },
          { label: 'functions.js：库函数骨架', body: SNIPPET_FUNCTIONS },
        ],
        { title: '插入哪份模板？' },
      );
      if (!pick) return;
      await editor.edit((b) => b.insert(editor.selection.active, pick.body));
    }),
  );
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}

// ==================================================================
//  工作区文件收集
// ==================================================================

async function collectWorkspaceFiles(): Promise<Array<{ uri: string; text: string }>> {
  const found = await vscode.workspace.findFiles(FILE_GLOB, '**/node_modules/**', 4000);
  const more = found.length ? [] : await vscode.workspace.findFiles(FALLBACK_GLOB, '**/node_modules/**', 2000);
  const uris = [...found, ...more];
  const out: Array<{ uri: string; text: string }> = [];
  for (const uri of uris) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      out.push({ uri: uri.toString(), text: new TextDecoder('utf-8').decode(bytes) });
    } catch {
      // 读不到就跳过（可能刚被删掉）
    }
  }
  return out;
}

// ==================================================================
//  类型声明
// ==================================================================

async function writeDts(context: vscode.ExtensionContext): Promise<string | undefined> {
  const dir = context.globalStorageUri;
  const file = vscode.Uri.joinPath(dir, 'liudungeon.d.ts');
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(buildDts()));
    return file.fsPath;
  } catch {
    return undefined;
  }
}

/**
 * 清掉早期版本遗留在工作区根目录的两个文件。
 *
 * 只在内容确实是本扩展生成的时候删，避免误删用户自己的 jsconfig.json。
 */
async function removeLegacyWorkspaceArtifacts(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const jsconfig = vscode.Uri.joinPath(folder.uri, 'jsconfig.json');
    try {
      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(jsconfig));
      const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as {
        include?: string[];
      };
      const generated =
        Array.isArray(parsed.include) &&
        parsed.include.length === 1 &&
        parsed.include[0].includes('.liudungeon');
      if (generated) await vscode.workspace.fs.delete(jsconfig);
    } catch {
      // 不存在或不是我们生成的，忽略
    }

    const legacyDir = vscode.Uri.joinPath(folder.uri, '.liudungeon');
    const legacyDts = vscode.Uri.joinPath(legacyDir, 'liudungeon.d.ts');
    try {
      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(legacyDts));
      if (text.includes('由 LiuDungeon 脚本支持扩展自动生成')) {
        await vscode.workspace.fs.delete(legacyDir, { recursive: true });
      }
    } catch {
      // 同上
    }
  }
}

// ==================================================================
//  插入模板
// ==================================================================

const SNIPPET_SCRIPTS = `# 生命周期脚本；只有 complete 里的发奖是"必须"的，其余是提示语
# 写法：|- 块里一行一条语句、行尾加分号；块里是纯 JS，注释要用 //（写 YAML 的 # 会报错）
start: |-
  action.title('@all', '&6副本名', '&7消灭所有敌人');

complete: |-
  action.title('@all', '&a&l通关！', '&7奖励已发放');
  action.grant_reward('@all', '通关奖励');
  action.wait('3秒');
  action.exit_dungeon();

fail: |-
  action.title('@all', '&c挑战失败', '&7再接再厉');
`;

const SNIPPET_MONSTERS = `groups:
  wave_1:
    spawn_timing:
      type: AUTO_START
    monsters:
      - id: Zombie
        location: '0,64,-10'
        amount: 3
        level: 1

  boss:
    spawn_timing:
      type: TRIGGERED
    trigger_group: wave_1
    on_end: action.complete_dungeon()
    monsters:
      - id: Husk
        location: '0,64,-20'
        amount: 1
        level: 5
        boss: true
`;

const SNIPPET_FUNCTIONS = `/**
 * 脚本函数库：这里的函数会被同副本的脚本按名字直接调用。
 * 参数里的 d 是 dungeon 对象，a 是 action 对象（调用时自己传进来）。
 */
function 是否清完(d) {
    return d.getTotalAliveMonsters() <= 0
}
`;
