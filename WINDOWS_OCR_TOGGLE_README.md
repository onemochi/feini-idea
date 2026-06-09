# Windows OCR 开关功能说明

## 功能概述

为菲尼合同引擎添加了一个 Windows OCR 开关按钮，允许用户在 EXE 版本中控制是否使用 Windows 系统 OCR 进行 PDF 识别。

## 主要特性

### 1. UI 界面
- **位置**：在 PDF 识别按钮旁边添加了一个开关按钮
- **图标**：🪟 Windows OCR
- **样式**：与现有的"Loading"开关保持一致的设计风格

### 2. 功能行为
- **默认状态**：关闭（使用 tesseract.js）
- **持久化**：用户的选择会保存在 localStorage 中，下次打开时自动恢复
- **实时反馈**：
  - 切换开关时会在终端日志中显示状态变化
  - OCR 引擎提示会实时更新显示当前使用的引擎

### 3. OCR 引擎选择逻辑

#### 开关开启时（EXE 环境）
```
✅ Windows 系统 OCR 可用
   → 使用 Windows.Media.Ocr（快速、离线、中文识别优秀）

❌ Windows 系统 OCR 不可用
   → 自动降级到 tesseract.js
```

#### 开关关闭时
```
→ 强制使用 tesseract.js（即使在 EXE 环境中）
```

#### 非 EXE 环境（浏览器）
```
→ 始终使用 tesseract.js（无论开关状态如何）
```

## 代码改动说明

### 1. HTML 结构 (index.html)

#### 添加开关按钮（第 889-900 行附近）
```html
<label class="prank-toggle-wrap" title="在 EXE 版本中控制是否使用 Windows 系统 OCR（默认关闭使用 tesseract.js）">
    <div class="prank-toggle-label"><span>🪟</span>Windows OCR</div>
    <div class="toggle-switch">
        <input type="checkbox" id="winOcrToggle" onchange="saveWinOcrToggle()">
        <div class="toggle-track"></div>
        <div class="toggle-thumb"></div>
    </div>
</label>
```

### 2. JavaScript 函数

#### 新增函数（第 938-953 行）

1. **saveWinOcrToggle()** - 保存开关状态
   - 将状态保存到 localStorage
   - 显示日志信息
   - 重新检测 OCR 引擎状态

2. **initWinOcrToggle()** - 初始化开关状态
   - 从 localStorage 读取上次保存的状态
   - 默认为关闭状态

3. **isWindowsOcrEnabled()** - 检查开关状态
   - 返回当前开关是否启用

#### 修改的函数

1. **initOcrAdapter()** (第 2365 行附近)
   - 添加了开关状态检查
   - 根据开关决定是否尝试使用 Windows OCR
   - 添加了详细的日志提示

2. **detectOcrEngine()** (第 1209 行附近)
   - 更新提示文本以反映开关状态
   - 区分"可用但关闭"和"已启用"两种状态

3. **window.addEventListener('DOMContentLoaded', ...)** (第 976 行附近)
   - 添加了 `initWinOcrToggle()` 的调用

## 使用说明

### 对于用户

1. **打开 EXE 版本**的菲尼合同引擎
2. 在 PDF 识别区域，点击"🔍 识别并拆分 PDF"按钮旁的 **🪟 Windows OCR** 开关
3. 开关状态说明：
   - **开启**（绿色）：使用 Windows 系统 OCR（快速、离线）
   - **关闭**（灰色）：使用 tesseract.js（在线下载模型）
4. 设置会自动保存，下次打开时自动恢复

### 推荐使用场景

#### 推荐开启 Windows OCR
- ✅ 在 Windows 10/11 系统上运行 EXE 版本
- ✅ 需要快速处理大量 PDF
- ✅ 离线环境或网络较慢
- ✅ 处理中文合同扫描件

#### 推荐关闭 Windows OCR（使用 tesseract.js）
- ✅ 在浏览器中使用（自动关闭）
- ✅ Windows OCR 语言包未安装
- ✅ 需要更好的英文识别
- ✅ 测试对比不同 OCR 引擎效果

## 技术细节

### 状态持久化
```javascript
// 保存
localStorage.setItem('useWindowsOcr', checked ? '1' : '0');

// 读取
const saved = localStorage.getItem('useWindowsOcr');
const enabled = saved === '1';  // 默认为 false
```

### OCR 引擎选择流程
```javascript
async function initOcrAdapter(btnEl) {
    const useWindowsOcr = isWindowsOcrEnabled();
    
    if (useWindowsOcr && window.feini && window.feini.ocr) {
        // 尝试使用 Windows OCR
        const st = await window.feini.ocr.status();
        if (st && st.ok) {
            return createWindowsOcrAdapter();
        }
    }
    
    // 降级到 tesseract.js
    return createTesseractAdapter();
}
```

## 测试建议

1. **EXE 环境测试**
   - 开关开启 → 验证使用 Windows OCR
   - 开关关闭 → 验证使用 tesseract.js
   - 重启应用 → 验证状态持久化

2. **浏览器环境测试**
   - 验证始终使用 tesseract.js
   - 验证开关不影响浏览器模式

3. **日志验证**
   - 切换开关时查看终端日志
   - PDF 识别时查看使用的引擎类型

## 注意事项

1. **默认关闭**：为了保证兼容性，默认使用 tesseract.js
2. **自动降级**：即使开启开关，如果 Windows OCR 不可用，会自动降级到 tesseract.js
3. **仅 EXE 生效**：在浏览器环境中，开关不影响 OCR 引擎选择
4. **语言包要求**：使用 Windows OCR 需要安装中文（简体）语言包

## 版本信息

- **添加日期**：2026-06-09
- **修改文件**：index.html
- **影响模块**：PDF 识别拆分功能
- **向后兼容**：是（默认关闭，不影响现有行为）

---

如有问题或建议，请联系开发团队。
