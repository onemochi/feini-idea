const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

// 版本号来源优先级：命令行参数 > package.json
// 例：node gitee-release.js v1.0.9   或   node gitee-release.js
let rawVersion = process.argv[2];
if (!rawVersion) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    if (pkg.version) rawVersion = 'v' + pkg.version;
  } catch (_) {}
}
const cleanVersion = rawVersion ? rawVersion.replace(/^v/, '') : '';

// ================= 配置区 =================
const CONFIG = {
  owner: 'Sincerity2077',        // Gitee 上的用户名或组织名
  repo: 'feini-idea',            // 仓库名
  token: process.env.GITEE_TOKEN,// 你的 Gitee 私人令牌 (放在 .env 文件中)
  version: rawVersion,           // 带 v 的版本号，例如 v1.0.8
  // 配置你要上传的所有附件路径
  assets: [
    path.join(__dirname, 'dist', 'latest.yml'),
    path.join(__dirname, 'dist', `菲尼合同引擎-便携版-${cleanVersion}.exe`),
    path.join(__dirname, 'dist', `菲尼合同引擎-${cleanVersion}-x64.exe.blockmap`),
    path.join(__dirname, 'dist', `菲尼合同引擎-${cleanVersion}-x64.exe`)
  ]
};
// ==========================================

const API_BASE = `https://gitee.com/api/v5/repos/${CONFIG.owner}/${CONFIG.repo}`;

async function run() {
  if (!CONFIG.version) {
    console.error('❌ 请提供版本号! 例如: npm run release v1.0.8');
    process.exit(1);
  }
  if (!CONFIG.token) {
    console.error('❌ 未找到 GITEE_TOKEN! 请检查 .env 文件。');
    process.exit(1);
  }

  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    console.log(`🚀 开始发布版本: ${CONFIG.version} (当前分支: ${currentBranch})...`);

    // 1. 删除旧的发行版 (增加防御机制)
    console.log('🗑️  清理旧的 Release...');
    await deleteReleaseIfExists('latest');
    await deleteReleaseIfExists(CONFIG.version);

    // 2. 在本地强制更新标签，并强制推送到远端
    console.log('🏷️  强制更新并推送 git 标签...');
    execSync('git tag -f latest', { stdio: 'inherit' });
    execSync('git push -f origin latest', { stdio: 'inherit' });
    
    execSync(`git tag -f ${CONFIG.version}`, { stdio: 'inherit' });
    execSync(`git push -f origin ${CONFIG.version}`, { stdio: 'inherit' });

    // 3. 创建新的 latest Release
    console.log('📦 创建新的 latest Release...');
    const createRes = await axios.post(`${API_BASE}/releases`, {
      access_token: CONFIG.token,
      tag_name: 'latest',
      name: CONFIG.version,
      body: `自动发版更新至 ${CONFIG.version}\n\n更新时间: ${new Date().toLocaleString()}`,
      target_commitish: currentBranch
    });
    
    if (!createRes.data || !createRes.data.id) {
      throw new Error(`创建 latest Release 失败，API返回异常: ${JSON.stringify(createRes.data)}`);
    }
    const newReleaseId = createRes.data.id;

    // 4. 为 latest 上传附件
    console.log('📤 开始上传附件到 latest...');
    for (const filePath of CONFIG.assets) {
      if (fs.existsSync(filePath)) {
        await uploadFile(newReleaseId, filePath);
      } else {
        console.error(`❌ 文件不存在，请检查打包是否成功: ${filePath}`);
      }
    }

    // 5. 创建归档的 Release 并上传附件
    console.log(`📦 创建归档 Release: ${CONFIG.version}...`);
    const archiveRes = await axios.post(`${API_BASE}/releases`, {
      access_token: CONFIG.token,
      tag_name: CONFIG.version,
      name: CONFIG.version,
      body: `归档版本 ${CONFIG.version}`,
      target_commitish: currentBranch
    });
    
    if (!archiveRes.data || !archiveRes.data.id) {
      throw new Error(`创建归档 Release 失败，API返回异常: ${JSON.stringify(archiveRes.data)}`);
    }
    const archiveReleaseId = archiveRes.data.id;
    
    console.log(`📤 开始上传附件到 ${CONFIG.version}...`);
    for (const filePath of CONFIG.assets) {
      if (fs.existsSync(filePath)) {
        await uploadFile(archiveReleaseId, filePath);
      }
    }

    console.log('🎉 发布成功！');
    console.log('🔗 请测试 latest.yml 链接是否可以下载:');
    console.log(`https://gitee.com/${CONFIG.owner}/${CONFIG.repo}/releases/download/latest/latest.yml`);

  } catch (error) {
    console.error('❌ 发布失败:', error.response ? error.response.data : error.message);
  }
}

// 抽离的：删除已存在的 Release 方法 (修复 null 报错问题)
async function deleteReleaseIfExists(tagName) {
  try {
    // 加上 access_token，否则私有仓库会 404 → 被误判为"不存在"
    const getRes = await axios.get(`${API_BASE}/releases/tags/${tagName}`, {
      params: { access_token: CONFIG.token }
    });

    // 防御性判断：如果 Gitee 返回 200 但是数据是 null
    if (!getRes.data || !getRes.data.id) {
      console.log(`   ℹ️ 没有找到旧的 Release [${tagName}] (数据为空)，跳过删除`);
      return;
    }

    const releaseId = getRes.data.id;
    await axios.delete(`${API_BASE}/releases/${releaseId}`, { params: { access_token: CONFIG.token } });
    console.log(`   ✅ 旧 Release [${tagName}] 已删除`);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      console.log(`   ℹ️ 没有找到旧的 Release [${tagName}]，跳过删除`);
    } else {
      throw e;
    }
  }
}

// 抽离的：上传文件方法 (防超时)
async function uploadFile(releaseId, filePath) {
  const fileName = path.basename(filePath);
  console.log(`   -> 正在上传 ${fileName} ...`);
  const form = new FormData();
  form.append('access_token', CONFIG.token);
  form.append('file', fs.createReadStream(filePath));

  await axios.post(`${API_BASE}/releases/${releaseId}/attach_files`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 0 // 防止大文件上传中断
  });
  console.log(`   ✅ ${fileName} 上传完成`);
}

run();