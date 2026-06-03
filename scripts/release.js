// 发布脚本：构建后整理产物，打印 Gitee Release 上传清单
//
// 工作流：
//   1. 改 package.json 的 version
//   2. npm run release  → 构建产物 + 本脚本生成清单
//   3. 按脚本输出指引，去 Gitee Release 网页删除旧的 latest tag、新建 latest tag、上传清单里的文件
//   4. 旧客户端启动后 5 秒自动从 Gitee 拉到新版本
//
// 之所以用固定 tag "latest"：electron-updater 启动时还不知道最新版本号，
// 必须先去拉一个固定 URL 的 latest.yml 才能知道有没有更新。
// 把每次最新版本都重新挂在 tag "latest" 下，URL 永远稳定。
// （想保留历史版本归档，可以另外用 v1.0.x 这种 tag 单独发，不影响自动更新主链路。）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const REPO_OWNER = 'Sincerity2077';
const REPO_NAME = 'feini-idea';

function fmtMB(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function listExeIn(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir);
}

function main() {
    if (!fs.existsSync(DIST)) {
        console.error('✗ dist/ 不存在，请先 npm run build');
        process.exit(1);
    }

    const items = listExeIn(DIST);
    const yml = items.find(f => /^latest\.yml$/i.test(f));
    if (!yml) {
        console.error('✗ 找不到 dist/latest.yml — 检查 package.json 的 build.publish 是否配置正确');
        process.exit(1);
    }

    const ymlContent = fs.readFileSync(path.join(DIST, yml), 'utf8');
    const versionMatch = ymlContent.match(/^version:\s*(\S+)/m);
    const version = versionMatch ? versionMatch[1] : '?';

    // 收集要上传的文件（仅当前版本，避免 dist 里堆积的旧版本干扰）
    const uploads = [];
    uploads.push({ name: yml, size: fs.statSync(path.join(DIST, yml)).size, must: true, why: '★ 自动更新元数据，必须上传' });
    for (const f of items) {
        // 文件名中必须包含当前版本号
        if (!f.includes(version)) continue;
        if (/-x64\.exe$/i.test(f)) uploads.push({ name: f, size: fs.statSync(path.join(DIST, f)).size, must: true, why: '★ NSIS 安装版 (autoUpdater 下载)' });
        else if (/-x64\.exe\.blockmap$/i.test(f)) uploads.push({ name: f, size: fs.statSync(path.join(DIST, f)).size, must: true, why: '★ 差量更新元数据 (减小后续更新流量)' });
        else if (/便携版/.test(f) && /\.exe$/i.test(f)) uploads.push({ name: f, size: fs.statSync(path.join(DIST, f)).size, must: false, why: '便携版 (用户首次下载用，autoUpdater 不依赖)' });
    }

    const totalSize = uploads.reduce((s, u) => s + u.size, 0);
    const releaseUrl = `https://gitee.com/${REPO_OWNER}/${REPO_NAME}/releases`;

    console.log('');
    console.log('━'.repeat(70));
    console.log(`  v${version} 构建完成，请按以下步骤发布到 Gitee Release`);
    console.log('━'.repeat(70));
    console.log('');
    console.log(`产物目录: ${DIST}`);
    console.log(`上传总量: ${fmtMB(totalSize)}`);
    console.log('');
    console.log('待上传文件:');
    for (const u of uploads) {
        console.log(`  ${u.must ? '✓' : '○'} ${u.name.padEnd(50)} ${fmtMB(u.size).padStart(10)}  ${u.why}`);
    }
    console.log('');
    console.log('━'.repeat(70));
    console.log('  Gitee Release 网页操作步骤');
    console.log('━'.repeat(70));
    console.log('');
    console.log(`1. 打开: ${releaseUrl}`);
    console.log('');
    console.log('2. 【若已有 latest tag】先点进去 → 编辑 → 删除旧附件');
    console.log('   或直接删掉 latest tag 后重建（推荐，干净）');
    console.log('');
    console.log('3. 创建新 release:');
    console.log(`   - Tag 名称:   latest         （注意：固定写 "latest"，不带 v 前缀）`);
    console.log(`   - 标题:       v${version}`);
    console.log(`   - 描述:       (随便写更新内容)`);
    console.log(`   - 上传附件:   把上面打 ✓ 的文件全部拖进附件区`);
    console.log('');
    console.log('4. 【可选】再为 v' + version + ' 单独建一个 tag 做归档:');
    console.log(`   - Tag: v${version}`);
    console.log(`   - 附件: 同上`);
    console.log('');
    console.log('5. 发布后用浏览器测试链接是否能直接下载:');
    console.log(`   https://gitee.com/${REPO_OWNER}/${REPO_NAME}/releases/download/latest/latest.yml`);
    console.log('');
    console.log('已装的旧客户端会在启动 5 秒后自动检查到这次更新。');
    console.log('━'.repeat(70));
}

main();
