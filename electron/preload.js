// 把 OCR / 默认模板等能力安全地暴露给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

// 自动更新事件订阅：渲染进程注册回调，主进程把 autoUpdater 事件转发过来
const updListeners = {};
const UPD_EVENTS = ['upd:checking', 'upd:available', 'upd:not-available', 'upd:progress', 'upd:downloaded', 'upd:error'];
for (const ev of UPD_EVENTS) {
    ipcRenderer.on(ev, (_e, payload) => {
        const cbs = updListeners[ev] || [];
        for (const cb of cbs) { try { cb(payload); } catch (_) {} }
    });
}

contextBridge.exposeInMainWorld('feini', {
    isElectron: true,
    ocr: {
        // 状态：返回 { ok, languages: [...] } 或 { ok:false, error }
        status: () => ipcRenderer.invoke('ocr:status'),
        // 把 PNG dataURL 交给主进程做 Windows OCR
        recognizeDataUrl: (dataUrl, opts) => ipcRenderer.invoke('ocr:recognize', { dataUrl, lang: opts && opts.lang }),
        recognizeBuffer: (buffer, opts) => ipcRenderer.invoke('ocr:recognize-buffer', { buffer, lang: opts && opts.lang }),
    },
    defaultTemplate: () => ipcRenderer.invoke('app:default-template'),
    updater: {
        currentVersion: () => ipcRenderer.invoke('upd:current-version'),
        check: () => ipcRenderer.invoke('upd:check'),
        installNow: () => ipcRenderer.invoke('upd:install'),
        on: (event, cb) => {
            const ev = event.startsWith('upd:') ? event : 'upd:' + event;
            if (!UPD_EVENTS.includes(ev)) return () => {};
            (updListeners[ev] = updListeners[ev] || []).push(cb);
            return () => {
                updListeners[ev] = (updListeners[ev] || []).filter(x => x !== cb);
            };
        },
    },
});
