// Electron 主进程
// 职责：
//   1. 启动浏览器窗口加载 index.html
//   2. 启动一个常驻 PowerShell 守护进程跑 Windows.Media.Ocr，对外提供 IPC OCR 服务
//   3. 把每页 PNG 暂存到 OS 临时目录，OCR 完成后立即清理
const { app, BrowserWindow, ipcMain, dialog, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; }
catch (e) { console.warn('electron-updater 未安装，自动更新功能禁用'); }

// ---------------------------------------------------------------------------
// 启动期防白屏 / 防黑屏修复（必须在 app.ready 之前执行）
// ---------------------------------------------------------------------------
// 1) 版本变了清掉 GPU/Code 缓存：Electron 升级后旧 shader 缓存会让 GPU 进程崩 → 白屏
//    比对放在 userData/.last-app-version，与版本号不一致就清缓存目录
function purgeStaleGpuCacheIfVersionChanged() {
    try {
        const userData = app.getPath('userData');
        const flagFile = path.join(userData, '.last-app-version');
        const cur = app.getVersion();
        let prev = null;
        try { prev = fs.readFileSync(flagFile, 'utf8').trim(); } catch (_) {}
        if (prev !== cur) {
            for (const dir of ['GPUCache', 'Code Cache', 'ShaderCache', 'DawnCache', 'GrShaderCache']) {
                const p = path.join(userData, dir);
                try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
            }
            try { fs.mkdirSync(userData, { recursive: true }); } catch (_) {}
            try { fs.writeFileSync(flagFile, cur, 'utf8'); } catch (_) {}
            console.log(`[startup] 版本由 ${prev || '(初次)'} → ${cur}，已清空 GPU / Code 缓存`);
        }
    } catch (e) { console.warn('[startup] 清理 GPU 缓存失败:', e.message); }
}
purgeStaleGpuCacheIfVersionChanged();

// 2) 黑屏自愈：启动期写一个 .boot-pending，ready-to-show 后删掉。
//    下次启动若发现这个标记还在 → 上次启动没渲染到首屏（多半 GPU 进程崩了 → 黑屏）→
//    自动禁用硬件加速，让朋友的电脑下次能正常打开
const BOOT_PENDING_FILE = path.join(app.getPath('userData'), '.boot-pending');
const HWACCEL_OFF_FILE = path.join(app.getPath('userData'), '.disable-hwaccel');
let lastBootCrashed = false;
try {
    if (fs.existsSync(BOOT_PENDING_FILE)) {
        // 上次启动留下了标记 → 没成功渲染 → 视为黑/白屏崩溃
        lastBootCrashed = true;
        try { fs.writeFileSync(HWACCEL_OFF_FILE, 'auto:' + new Date().toISOString(), 'utf8'); } catch (_) {}
        try { fs.unlinkSync(BOOT_PENDING_FILE); } catch (_) {}
        console.warn('[startup] 检测到上次启动未渲染首屏，已自动切换到软件渲染（GPU 关闭）');
    }
} catch (_) {}

// 3) 命令行参数 / 标记文件 / 自动检测，三选一即可关闭硬件加速
const argSafeMode = process.argv.some(a => a === '--safe-mode' || a === '--no-gpu' || a === '--disable-gpu');
let hwAccelDisabled = false;
try {
    if (argSafeMode || fs.existsSync(HWACCEL_OFF_FILE)) {
        // disableHardwareAcceleration 内部已会启用软件渲染兜底；额外指定 ANGLE swiftshader
        // 是为了在某些虚拟机/远程桌面上彻底避免去探测真实 GPU
        app.disableHardwareAcceleration();
        app.commandLine.appendSwitch('disable-gpu-compositing');
        app.commandLine.appendSwitch('use-angle', 'swiftshader');
        hwAccelDisabled = true;
        console.log('[startup] 硬件加速已关闭（' + (argSafeMode ? '命令行 --safe-mode' : '检测到关闭标记') + '）');
    }
} catch (_) {}

// 4) 写入本次启动 boot-pending；ready-to-show 后删除。两份都写在 userData 下
try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(BOOT_PENDING_FILE, String(Date.now()), 'utf8');
} catch (_) {}

// ---------------------------------------------------------------------------
// PowerShell OCR 守护进程：开机即起、退出时回收
// ---------------------------------------------------------------------------
class WinOcrService {
    constructor(scriptPath) {
        this.scriptPath = scriptPath;
        this.proc = null;
        this.ready = false;
        this.languages = [];
        this.pending = new Map();        // id -> { resolve, reject }
        this.lineBuf = '';
        this.startQueue = [];            // 等待 ready 的请求
        this.startError = null;
    }

    async ensureStarted() {
        if (this.ready) return;
        if (this.proc) {
            // 启动中：等握手
            return new Promise((resolve, reject) => {
                this.startQueue.push({ resolve, reject });
            });
        }
        return new Promise((resolve, reject) => {
            this.startQueue.push({ resolve, reject });
            this._spawn();
        });
    }

    _spawn() {
        const args = [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-File', this.scriptPath,
        ];
        const proc = spawn('powershell.exe', args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc = proc;

        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => this._onStdout(chunk));
        proc.stderr.on('data', (err) => {
            // 把 PowerShell 报错也透传给前端，便于诊断
            console.warn('[win-ocr stderr]', err.trim());
        });
        proc.on('exit', (code) => {
            console.warn('[win-ocr] 守护进程退出 code=' + code);
            this.ready = false;
            this.proc = null;
            const e = new Error('OCR 守护进程已退出 (code=' + code + ')');
            for (const [, p] of this.pending) p.reject(e);
            this.pending.clear();
            for (const q of this.startQueue) q.reject(e);
            this.startQueue = [];
        });
        proc.on('error', (err) => {
            this.startError = err;
            for (const q of this.startQueue) q.reject(err);
            this.startQueue = [];
        });
    }

    _onStdout(chunk) {
        this.lineBuf += chunk;
        let idx;
        while ((idx = this.lineBuf.indexOf('\n')) >= 0) {
            const line = this.lineBuf.slice(0, idx).replace(/\r$/, '');
            this.lineBuf = this.lineBuf.slice(idx + 1);
            if (!line.trim()) continue;
            let msg;
            try { msg = JSON.parse(line); }
            catch (e) { console.warn('[win-ocr] 非 JSON 输出:', line); continue; }

            if (msg.ready) {
                this.ready = true;
                this.languages = msg.languages || [];
                for (const q of this.startQueue) q.resolve();
                this.startQueue = [];
                continue;
            }
            if (msg.id && this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.ok) p.resolve(msg);
                else p.reject(new Error(msg.error || 'OCR 失败'));
            }
        }
    }

    async recognizeFile(filePath, lang) {
        await this.ensureStarted();
        const id = crypto.randomBytes(8).toString('hex');
        const req = { id, path: filePath, lang: lang || 'zh-Hans-CN' };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.proc.stdin.write(JSON.stringify(req) + '\n', 'utf8');
            } catch (e) {
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    shutdown() {
        if (!this.proc) return;
        const pid = this.proc.pid;
        try { this.proc.stdin.write('{"cmd":"quit"}\n'); } catch (_) {}
        try { this.proc.kill(); } catch (_) {}
        // Windows 上 child.kill() 不会递归杀子进程，PowerShell 持有的 .ps1 文件句柄
        // 还会拖住 NSIS 覆盖安装；用 taskkill /F /T 把整棵进程树连根拔除
        if (process.platform === 'win32' && pid) {
            try {
                execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
            } catch (_) {}
        }
        this.proc = null;
        this.ready = false;
    }
}

let ocrService = null;
let mainWindow = null;
let tmpRoot = null;

function getResourcePath(rel) {
    // 打包后资源在 process.resourcesPath；开发态用源码路径
    const packed = path.join(process.resourcesPath, rel);
    if (fs.existsSync(packed)) return packed;
    return path.join(__dirname, '..', rel);
}

function getOcrScriptPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'ocr', 'win-ocr.ps1');
    }
    return path.join(__dirname, 'ocr', 'win-ocr.ps1');
}

function getDefaultTemplatePath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'ceshi', '模板.xlsx');
    }
    return path.join(__dirname, '..', 'ceshi', '模板.xlsx');
}

function ensureTmpRoot() {
    if (tmpRoot && fs.existsSync(tmpRoot)) return tmpRoot;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feini-ocr-'));
    return tmpRoot;
}

function cleanupTmp() {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
    tmpRoot = null;
}

// ---------------------------------------------------------------------------
// IPC：渲染进程把 PNG dataURL 发过来 → 主进程写到临时文件 → PowerShell OCR
// ---------------------------------------------------------------------------
ipcMain.handle('ocr:status', async () => {
    try {
        await ocrService.ensureStarted();
        return { ok: true, languages: ocrService.languages };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('ocr:recognize', async (event, payload) => {
    // payload: { dataUrl: 'data:image/png;base64,...', lang?: 'zh-Hans-CN' }
    const root = ensureTmpRoot();
    const { dataUrl, lang } = payload || {};
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        throw new Error('无效的图片数据');
    }
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const buf = Buffer.from(b64, 'base64');
    const fname = crypto.randomBytes(8).toString('hex') + '.png';
    const fpath = path.join(root, fname);
    await fs.promises.writeFile(fpath, buf);
    try {
        const r = await ocrService.recognizeFile(fpath, lang || 'zh-Hans-CN');
        return r;
    } finally {
        fs.promises.unlink(fpath).catch(() => {});
    }
});

ipcMain.handle('ocr:recognize-buffer', async (event, payload) => {
    // payload: { buffer: ArrayBuffer/Uint8Array, lang? }
    const root = ensureTmpRoot();
    const { buffer, lang } = payload || {};
    if (!buffer) throw new Error('无效的图片数据');
    const buf = Buffer.from(buffer);
    const fname = crypto.randomBytes(8).toString('hex') + '.png';
    const fpath = path.join(root, fname);
    await fs.promises.writeFile(fpath, buf);
    try {
        return await ocrService.recognizeFile(fpath, lang || 'zh-Hans-CN');
    } finally {
        fs.promises.unlink(fpath).catch(() => {});
    }
});

ipcMain.handle('app:default-template', async () => {
    const p = getDefaultTemplatePath();
    if (!fs.existsSync(p)) return { ok: false, error: '默认模板不存在: ' + p };
    const buf = await fs.promises.readFile(p);
    return { ok: true, name: path.basename(p), data: buf };
});

// ---------------------------------------------------------------------------
// 自动更新（electron-updater + Netlify generic provider）
//   渲染进程通过 IPC 触发 / 控制；事件回流给渲染进程做 UI 提示
// ---------------------------------------------------------------------------
function setupAutoUpdater() {
    if (!autoUpdater) return;
    if (!app.isPackaged) {
        // 开发态不检查更新（否则会去找 dev-app-update.yml 报错）
        return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    const send = (channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, payload);
        }
    };

    autoUpdater.on('checking-for-update', () => send('upd:checking'));
    autoUpdater.on('update-available', (info) => send('upd:available', {
        version: info.version, releaseDate: info.releaseDate, releaseNotes: info.releaseNotes,
    }));
    autoUpdater.on('update-not-available', (info) => send('upd:not-available', {
        version: info && info.version,
    }));
    autoUpdater.on('download-progress', (p) => send('upd:progress', {
        percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond,
    }));
    autoUpdater.on('update-downloaded', (info) => send('upd:downloaded', { version: info.version }));
    autoUpdater.on('error', (err) => send('upd:error', { message: err && err.message }));
}

ipcMain.handle('upd:check', async () => {
    if (!autoUpdater || !app.isPackaged) return { ok: false, error: '当前为开发态或缺少 updater' };
    try {
        const r = await autoUpdater.checkForUpdates();
        return { ok: true, version: r && r.updateInfo && r.updateInfo.version };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('upd:install', async () => {
    if (!autoUpdater) return { ok: false, error: 'updater 不可用' };
    // 安装前先彻底关闭 OCR 守护进程：否则 PowerShell 会持有 resources\ocr\win-ocr.ps1
    // 的文件句柄，NSIS 覆盖部分文件失败 → 新版启动时资源不一致 → 白屏
    try { if (ocrService) ocrService.shutdown(); } catch (_) {}
    cleanupTmp();
    // 留 400ms 让 taskkill 真正生效，再触发 quitAndInstall
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 400);
    return { ok: true };
});

ipcMain.handle('upd:current-version', async () => app.getVersion());

// ---------------------------------------------------------------------------
// 窗口与生命周期
// ---------------------------------------------------------------------------
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 1024,
        minHeight: 720,
        title: '菲尼合同引擎',
        icon: nativeImage.createFromPath(path.join(__dirname, '..', 'icon.ico')),
        backgroundColor: '#f0f4ff',
        show: false,                       // 等首屏渲染好再 show，杜绝白屏闪现
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false,
        },
    });
    mainWindow.setMenuBarVisibility(false);

    // ready-to-show：DOM 已经布好首屏，再显示窗口；ready 不来时用 5s 兜底
    let shown = false;
    const showOnce = () => {
        if (!shown && mainWindow && !mainWindow.isDestroyed()) {
            shown = true;
            mainWindow.show();
            // 首屏成功 → 清掉 boot-pending；下次启动就不会被当成黑屏崩溃
            try { fs.unlinkSync(BOOT_PENDING_FILE); } catch (_) {}
            // 若是从黑屏自愈状态启动的，告诉用户软件渲染已开启（避免他困惑为啥变慢）
            if (lastBootCrashed && mainWindow.webContents) {
                mainWindow.webContents.once('did-finish-load', () => {
                    dialog.showMessageBox(mainWindow, {
                        type: 'info',
                        title: '已切换到兼容模式',
                        message: '上次启动出现黑屏/崩溃，已自动关闭硬件加速以保证可用性。',
                        detail: `如需重新启用 GPU 加速，可删除以下文件后重启：\n${HWACCEL_OFF_FILE}\n\n或在快捷方式后加参数 --safe-mode 来强制兼容模式。`,
                        buttons: ['知道了'],
                    }).catch(() => {});
                });
            }
        }
    };
    mainWindow.once('ready-to-show', showOnce);
    setTimeout(showOnce, 5000);

    // index.html 与 electron/ 同处一个 app.asar（或开发目录），相对路径一致
    const loadPath = path.join(__dirname, '..', 'index.html');
    let reloadAttempts = 0;
    const tryLoad = () => mainWindow.loadFile(loadPath).catch(err => {
        console.error('加载 index.html 失败:', err);
        if (reloadAttempts++ < 2) {
            console.log(`[main] 第 ${reloadAttempts} 次重试加载 index.html...`);
            setTimeout(tryLoad, 800);
        } else {
            dialog.showErrorBox('加载失败', '无法加载 index.html: ' + err.message);
        }
    });
    tryLoad();

    // 渲染层崩溃 / 加载失败 → 自动恢复一次。再失败给用户一个明确的弹窗
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
        if (!isMain) return;
        console.warn(`[renderer] did-fail-load code=${code} desc=${desc} url=${url}`);
        if (reloadAttempts++ < 2) setTimeout(tryLoad, 800);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
        console.warn('[renderer] render-process-gone:', details);
        if (details && details.reason && details.reason !== 'clean-exit') {
            if (reloadAttempts++ < 2) {
                console.log('[main] 渲染进程异常退出，自动重载页面...');
                setTimeout(tryLoad, 500);
            } else {
                dialog.showErrorBox('页面崩溃',
                    `渲染进程异常退出（${details.reason}）。\n\n` +
                    `若问题持续：\n` +
                    `1) 重启程序\n` +
                    `2) 在用户目录新建空文件「.disable-hwaccel」后重启可禁用 GPU 加速：\n` +
                    `   ${path.join(app.getPath('userData'), '.disable-hwaccel')}`
                );
            }
        }
    });
    mainWindow.on('unresponsive', () => console.warn('[renderer] 主线程无响应（可能是大文件解析）'));

    // mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
    // GPU 进程崩溃 → 强烈的黑屏信号。立即写关闭硬件加速的标记，下次启动直接走软件渲染
    app.on('child-process-gone', (_e, details) => {
        if (details && details.type === 'GPU' && details.reason !== 'clean-exit') {
            console.warn('[gpu] GPU 进程崩溃:', details);
            try { fs.writeFileSync(HWACCEL_OFF_FILE, 'gpu-crash:' + new Date().toISOString(), 'utf8'); } catch (_) {}
        }
    });
    app.on('gpu-process-crashed', (_e, killed) => {
        // 老版本 Electron 的事件，留兼容
        console.warn('[gpu] gpu-process-crashed killed=', killed);
        try { fs.writeFileSync(HWACCEL_OFF_FILE, 'gpu-crash:' + new Date().toISOString(), 'utf8'); } catch (_) {}
    });

    ocrService = new WinOcrService(getOcrScriptPath());
    // 异步预热（不阻塞窗口）
    ocrService.ensureStarted().catch(err => {
        console.warn('OCR 守护进程启动失败:', err.message);
    });
    createWindow();
    setupAutoUpdater();
    // 启动 5 秒后做首次检查（避免阻塞首屏；网络不通时静默失败）
    if (autoUpdater && app.isPackaged) {
        setTimeout(() => {
            autoUpdater.checkForUpdates().catch(err => console.warn('自动更新检查失败:', err.message));
        }, 5000);
    }
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (ocrService) ocrService.shutdown();
    cleanupTmp();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (ocrService) ocrService.shutdown();
    cleanupTmp();
});
