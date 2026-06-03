// Electron 主进程
// 职责：
//   1. 启动浏览器窗口加载 index.html
//   2. 启动一个常驻 PowerShell 守护进程跑 Windows.Media.Ocr，对外提供 IPC OCR 服务
//   3. 把每页 PNG 暂存到 OS 临时目录，OCR 完成后立即清理
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; }
catch (e) { console.warn('electron-updater 未安装，自动更新功能禁用'); }

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
        try { this.proc.stdin.write('{"cmd":"quit"}\n'); } catch (_) {}
        try { this.proc.kill(); } catch (_) {}
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
    // 立即关闭并安装
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
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
        backgroundColor: '#f0f4ff',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    mainWindow.setMenuBarVisibility(false);
    // index.html 与 electron/ 同处一个 app.asar（或开发目录），相对路径一致
    const loadPath = path.join(__dirname, '..', 'index.html');
    mainWindow.loadFile(loadPath).catch(err => {
        console.error('加载 index.html 失败:', err);
        dialog.showErrorBox('加载失败', '无法加载 index.html: ' + err.message);
    });
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
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
