// 生成符合 Windows 规范的多尺寸 icon.ico
// 必须用 Electron 跑：npx electron scripts/build-icon.js
//
// 输出：
//   icon.ico                     —— 16/24/32/48/64/128/256 七层多尺寸 ICO
//   build/icons/icon-NN.png      —— 中间产物
//
// 修复了什么：原 icon.ico 只有一张 256×256 内嵌 PNG，Windows 标题栏需要 16/24/32 时
// 只能强缩，标题栏图标边缘糊掉看起来"不完整"。多尺寸打包后系统按需选层。

const electron = require('electron');
const { app, BrowserWindow } = electron;
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'icon.svg');
const ICO_PATH = path.join(ROOT, 'icon.ico');
const PNG_DIR = path.join(ROOT, 'build', 'icons');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

if (!app) {
    console.error('请用 Electron 运行此脚本：npx electron scripts/build-icon.js');
    process.exit(1);
}

async function renderOne(size, dataUrl) {
    const win = new BrowserWindow({
        width: size, height: size, show: false, frame: false, transparent: true,
        useContentSize: true,
        webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    const html = `<!doctype html><html><head><style>
        html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden;}
        img{display:block;width:${size}px;height:${size}px;}
    </style></head><body><img src="${dataUrl}"/></body></html>`;
    await win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html).toString('base64'));
    await new Promise(r => setTimeout(r, 120)); // 等图片解码
    const img = await win.webContents.capturePage();
    const png = img.resize({ width: size, height: size, quality: 'best' }).toPNG();
    win.destroy();
    return png;
}

async function main() {
    if (!fs.existsSync(SVG_PATH)) {
        console.error('未找到 icon.svg，先跑：node create-icon.js');
        app.exit(1); return;
    }
    fs.mkdirSync(PNG_DIR, { recursive: true });
    const svgBuf = fs.readFileSync(SVG_PATH);
    const dataUrl = 'data:image/svg+xml;base64,' + svgBuf.toString('base64');

    const pngPaths = [];
    for (const size of SIZES) {
        const png = await renderOne(size, dataUrl);
        const out = path.join(PNG_DIR, `icon-${size}.png`);
        fs.writeFileSync(out, png);
        pngPaths.push(out);
        console.log(`  ✓ 渲染 ${size}×${size} (${png.length} bytes)`);
    }

    const pngToIco = require('png-to-ico');
    const ico = await pngToIco(pngPaths);
    fs.writeFileSync(ICO_PATH, ico);
    console.log(`✓ 生成 ${ICO_PATH}（${SIZES.length} 层多尺寸，${ico.length} bytes）`);
    app.exit(0);
}

app.whenReady().then(main).catch(err => {
    console.error('生成失败：', err);
    app.exit(1);
});
