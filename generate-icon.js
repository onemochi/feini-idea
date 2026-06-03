const fs = require('fs');
const path = require('path');

// 创建一个简单的 SVG 图标
const svgContent = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <!-- 背景 -->
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#4a90e2"/>
      <stop offset="100%" style="stop-color:#357abd"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="80" fill="url(#bg)"/>
  
  <!-- 合同/文档图标 -->
  <g transform="translate(256, 256)">
    <!-- 文档主体 -->
    <rect x="-90" y="-110" width="180" height="220" rx="10" fill="white" opacity="0.95"/>
    <!-- 文档折角 -->
    <path d="M60,-110 L90,-110 L90,-80 Z" fill="#e8f0ff"/>
    <!-- 文档线条 -->
    <rect x="-60" y="-60" width="100" height="12" rx="4" fill="#4a90e2" opacity="0.8"/>
    <rect x="-60" y="-30" width="120" height="12" rx="4" fill="#4a90e2" opacity="0.6"/>
    <rect x="-60" y="0" width="90" height="12" rx="4" fill="#4a90e2" opacity="0.8"/>
    <rect x="-60" y="30" width="110" height="12" rx="4" fill="#4a90e2" opacity="0.6"/>
    <rect x="-60" y="60" width="80" height="12" rx="4" fill="#4a90e2" opacity="0.8"/>
  </g>
  
  <!-- 文字 "菲尼" -->
  <text x="256" y="430" text-anchor="middle" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="72" font-weight="bold" fill="white"/>
</svg>
`;

// 保存 SVG
fs.writeFileSync(path.join(__dirname, 'icon.svg'), svgContent.trim());
console.log('✅ 已生成 icon.svg');

// 创建一个简单的 HTML 用于在浏览器中打开并下载 PNG
const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>生成图标</title>
    <style>
        body { font-family: Microsoft YaHei, sans-serif; padding: 40px; text-align: center; }
        .container { max-width: 600px; margin: 0 auto; }
        button { padding: 15px 40px; font-size: 18px; margin: 10px; cursor: pointer; background: #4a90e2; color: white; border: none; border-radius: 8px; }
        button:hover { background: #357abd; }
        .preview { margin: 30px 0; }
        svg { width: 300px; height: 300px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>菲尼合同引擎 - 图标预览</h2>
        <div class="preview" id="preview"></div>
        <button onclick="downloadPng(256)">下载 256x256 PNG</button>
        <button onclick="downloadPng(512)">下载 512x512 PNG</button>
        <p style="color: #666; margin-top: 30px;">下载后，请使用在线工具将 PNG 转换为 ICO 格式</p>
        <p style="color: #666;">推荐工具：https://convertio.co/zh/png-ico/</p>
    </div>
    <script>
        const svgCode = \`${svgContent.trim()}\`;
        document.getElementById('preview').innerHTML = svgCode;
        
        function downloadPng(size) {
            const svg = new Blob([svgCode], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(svg);
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, size, size);
                canvas.toBlob(function(blob) {
                    const link = document.createElement('a');
                    link.download = 'icon-' + size + '.png';
                    link.href = URL.createObjectURL(blob);
                    link.click();
                    URL.revokeObjectURL(url);
                });
            };
            img.src = url;
        }
    </script>
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'icon-generator.html'), htmlContent);
console.log('✅ 已生成 icon-generator.html');
console.log('');
console.log('📝 下一步：');
console.log('1. 在浏览器中打开 icon-generator.html');
console.log('2. 下载 256x256 或 512x512 PNG');
console.log('3. 转换为 ICO 格式（推荐 https://convertio.co/zh/png-ico/）');
console.log('4. 将 ICO 文件命名为 icon.ico 放在项目根目录');
