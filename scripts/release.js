// 一站式发版脚本：构建 → 自动上传到 Gitee Release
// 工作流：
//   1. 改 package.json 的 version 字段（如 1.0.9 → 1.0.10）
//   2. npm run release    → 自动跑 electron-builder + 调用 gitee-release.js
//   3. 旧客户端启动 5 秒后从 Gitee 拉到新版本
//
// 之所以用固定 tag "latest"：electron-updater 启动时还不知道最新版本号，
// 必须先去拉一个固定 URL 的 latest.yml。把每次最新版本都挂在 tag "latest" 下，URL 永远稳定。
// 同时再创建一个 v1.0.x tag 做归档，互不干扰。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const REPO_OWNER = 'Sincerity2077';
const REPO_NAME = 'feini-idea';

function fmtMB(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function red(s)   { return '\x1b[31m' + s + '\x1b[0m'; }
function green(s) { return '\x1b[32m' + s + '\x1b[0m'; }
function cyan(s)  { return '\x1b[36m' + s + '\x1b[0m'; }
function dim(s)   { return '\x1b[2m'  + s + '\x1b[0m'; }

function main() {
    // 0. 校验产物
    if (!fs.existsSync(DIST)) {
        console.error(red('✗ dist/ 不存在，请检查 electron-builder 是否成功'));
        process.exit(1);
    }
    const items = fs.readdirSync(DIST);
    const yml = items.find(f => /^latest\.yml$/i.test(f));
    if (!yml) {
        console.error(red('✗ 找不到 dist/latest.yml — 检查 package.json 的 build.publish'));
        process.exit(1);
    }
    const ymlContent = fs.readFileSync(path.join(DIST, yml), 'utf8');
    const versionMatch = ymlContent.match(/^version:\s*(\S+)/m);
    const version = versionMatch ? versionMatch[1] : null;
    if (!version) {
        console.error(red('✗ 无法从 latest.yml 解析版本号'));
        process.exit(1);
    }

    // 1. 列出本次会上传的文件（同版本号 + yml）
    const uploads = [];
    uploads.push({ name: yml, size: fs.statSync(path.join(DIST, yml)).size });
    for (const f of items) {
        if (!f.includes(version)) continue;
        if (/-x64\.exe$/i.test(f) || /-x64\.exe\.blockmap$/i.test(f)) {
            uploads.push({ name: f, size: fs.statSync(path.join(DIST, f)).size });
        } else if (/便携版/.test(f) && /\.exe$/i.test(f)) {
            uploads.push({ name: f, size: fs.statSync(path.join(DIST, f)).size });
        }
    }
    const totalSize = uploads.reduce((s, u) => s + u.size, 0);

    console.log('');
    console.log(cyan('━'.repeat(70)));
    console.log(cyan(`  构建完成 v${version} — 准备上传到 Gitee Release`));
    console.log(cyan('━'.repeat(70)));
    console.log('');
    console.log(`产物目录: ${dim(DIST)}`);
    console.log(`上传总量: ${fmtMB(totalSize)}`);
    console.log('');
    console.log('附件清单:');
    for (const u of uploads) {
        console.log(`  • ${u.name.padEnd(50)} ${fmtMB(u.size).padStart(10)}`);
    }
    console.log('');

    // 2. 跳过模式：传 --dry-run / --no-upload 时只打印清单不上传
    if (process.argv.includes('--dry-run') || process.argv.includes('--no-upload')) {
        console.log(cyan('━'.repeat(70)));
        console.log('已跳过自动上传 (--dry-run)，请手动操作:');
        console.log(`  打开 https://gitee.com/${REPO_OWNER}/${REPO_NAME}/releases`);
        console.log(`  Tag 名称: ${green('latest')}（固定，不带 v）`);
        console.log(`  附件: 上述清单`);
        console.log(cyan('━'.repeat(70)));
        return;
    }

    // 3. 检查 .env 里有没有 GITEE_TOKEN —— 没配则提示
    require('dotenv').config({ path: path.join(ROOT, '.env') });
    if (!process.env.GITEE_TOKEN) {
        console.error(red('✗ 未找到 GITEE_TOKEN'));
        console.error('');
        console.error('请在项目根目录创建 .env 文件，写入:');
        console.error(green('  GITEE_TOKEN=你的Gitee私人令牌'));
        console.error('');
        console.error('Gitee 私人令牌生成: https://gitee.com/profile/personal_access_tokens');
        console.error('需要勾选 projects 权限');
        console.error('');
        console.error('或者使用 npm run release -- --dry-run 跳过自动上传');
        process.exit(1);
    }

    // 4. 自动调 gitee-release.js（用 v 前缀的版本号作为归档 tag）
    console.log(cyan('━'.repeat(70)));
    console.log(cyan(`  自动上传到 Gitee Release (tag: latest + v${version})`));
    console.log(cyan('━'.repeat(70)));
    console.log('');

    const giteeScript = path.join(ROOT, 'gitee-release.js');
    if (!fs.existsSync(giteeScript)) {
        console.error(red('✗ 找不到 gitee-release.js'));
        process.exit(1);
    }
    const r = spawnSync('node', [giteeScript, 'v' + version], {
        cwd: ROOT,
        stdio: 'inherit',
    });
    if (r.status !== 0) {
        console.error('');
        console.error(red('✗ Gitee 上传失败，请检查上方日志'));
        console.error(dim('  调试提示：可以加 --dry-run 只构建不上传'));
        process.exit(r.status || 1);
    }

    console.log('');
    console.log(cyan('━'.repeat(70)));
    console.log(green(`  ✅ 全部完成！v${version} 已发布`));
    console.log(cyan('━'.repeat(70)));
    console.log(`验证更新元数据: https://gitee.com/${REPO_OWNER}/${REPO_NAME}/releases/download/latest/latest.yml`);
    console.log(`Release 主页:    https://gitee.com/${REPO_OWNER}/${REPO_NAME}/releases`);
    console.log('');
    console.log('已装的旧客户端启动 5 秒后会自动检查到这次更新。');
}

main();
