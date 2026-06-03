// 发布脚本：把 electron-builder 产物拷到 netlify-site/updates/
//   - latest.yml   (autoUpdater 必读，决定有无新版本)
//   - *-x64.exe    (NSIS 安装版，自动更新会下这个)
//   - *.exe.blockmap (差量更新元数据，几 KB)
//   - 便携版 exe   (展示页用，自动更新不依赖)
//
// 旧版本 exe 默认会被清理，避免占用 Netlify 流量配额；
// 想保留历史版本请加 --keep-old 标志。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TARGET = path.join(ROOT, 'netlify-site', 'updates');
const KEEP_OLD = process.argv.includes('--keep-old');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function copyFile(src, dst) {
    fs.copyFileSync(src, dst);
    const st = fs.statSync(dst);
    const sizeMB = (st.size / 1024 / 1024).toFixed(2);
    console.log(`  ✓ ${path.basename(dst)} (${sizeMB} MB)`);
}

function listExeIn(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => /\.(exe|blockmap)$/i.test(f) || /^latest.*\.yml$/i.test(f));
}

function main() {
    if (!fs.existsSync(DIST)) {
        console.error('✗ dist/ 不存在，请先 npm run build 或 electron-builder --win');
        process.exit(1);
    }
    ensureDir(TARGET);

    console.log('▶ 正在收集发布产物 → ' + TARGET);

    // 清理旧版本（保留 .gitkeep）
    if (!KEEP_OLD) {
        const stale = listExeIn(TARGET);
        if (stale.length) {
            console.log(`▶ 清理旧版本 ${stale.length} 个文件 (使用 --keep-old 可保留)`);
            for (const f of stale) {
                try { fs.unlinkSync(path.join(TARGET, f)); }
                catch (e) { console.warn('  ! 删除失败 ' + f + ': ' + e.message); }
            }
        }
    }

    const items = fs.readdirSync(DIST);
    let copied = 0;

    // latest.yml 是核心 — 先找它，找不到说明没有 publish 配置
    const yml = items.find(f => /^latest\.yml$/i.test(f));
    if (!yml) {
        console.error('✗ 找不到 dist/latest.yml — 检查 package.json 的 build.publish 是否配置正确');
        process.exit(1);
    }
    copyFile(path.join(DIST, yml), path.join(TARGET, yml));
    copied++;

    // 安装版 + blockmap（NSIS 产物，命名形如 菲尼合同引擎-1.0.0-x64.exe）
    for (const f of items) {
        if (/-x64\.exe$/i.test(f) || /-x64\.exe\.blockmap$/i.test(f)) {
            copyFile(path.join(DIST, f), path.join(TARGET, f));
            copied++;
        }
    }

    // 便携版（仅供展示页直链下载，不参与自动更新）
    for (const f of items) {
        if (/便携版/.test(f) && /\.exe$/i.test(f)) {
            copyFile(path.join(DIST, f), path.join(TARGET, f));
            copied++;
        }
    }

    console.log(`✓ 已收集 ${copied} 个文件到 netlify-site/updates/`);
    console.log('');
    console.log('下一步：把 netlify-site 整个目录部署到 Netlify');
    console.log('  方法 A (CLI): npx netlify deploy --prod --dir=netlify-site');
    console.log('  方法 B: Netlify 仪表盘 → 拖入 netlify-site 文件夹');
    console.log('');
    console.log('部署后旧客户端启动 5 秒会自动拉取新版本。');
}

main();
