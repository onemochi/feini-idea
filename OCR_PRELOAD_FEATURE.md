# OCR 模型预加载功能说明

## 功能概述

为了解决 tesseract.js 首次使用时需要下载模型（约30MB）导致等待时间过长的问题，新增了 **OCR 模型预加载** 功能。启用后，页面加载时会在后台自动下载并初始化 OCR 模型，首次识别时无需等待。

## 问题背景

### 原有流程的问题
1. 用户点击"识别并拆分 PDF"按钮
2. 系统开始下载 tesseract.js 模型（约30MB，中文+英文）
3. 用户等待 30秒-2分钟（取决于网速）
4. 模型加载完成后才开始识别
5. **体验较差**：每次首次使用都要等待

### 新功能的优势
1. ✅ **后台预加载**：页面加载时在后台下载模型
2. ✅ **用户无感知**：不影响其他操作，静默完成
3. ✅ **即开即用**：首次识别时模型已就绪，无需等待
4. ✅ **可控开关**：用户可选择是否启用，避免不必要的流量消耗

---

## 功能特性

### 1. UI 界面
- **位置**：在 PDF 识别按钮旁，Windows OCR 开关的右侧
- **图标**：⚡ 预加载模型
- **样式**：与其他开关保持一致的设计

### 2. 工作机制

#### 启用时的流程
```
1. 页面加载完成 (DOMContentLoaded)
   ↓
2. 检查开关状态（从 localStorage 读取）
   ↓
3. 如果启用：后台开始预加载
   ├─ 检查是否已经在加载/已完成 → 跳过
   ├─ 检查是否启用了 Windows OCR → 跳过预加载
   └─ 开始下载并初始化 tesseract.js 模型
   ↓
4. 预加载完成
   ├─ 缓存到全局变量 preloadedWorkers
   ├─ 在终端显示完成日志
   └─ 标记 preloadProgress.complete = true
   ↓
5. 用户点击识别时
   ├─ 检测到已预加载的 workers
   ├─ 直接使用，无需重新加载
   └─ 立即开始识别（无等待）
```

#### 禁用时的流程
```
1. 页面加载完成
   ↓
2. 不进行预加载
   ↓
3. 用户点击识别时
   ├─ 检测到无预加载 workers
   ├─ 即时创建 workers（显示加载进度）
   └─ 首次使用需要等待下载模型
```

### 3. 智能逻辑

#### 自动跳过预加载的情况
1. **已启用 Windows OCR**
   - Windows OCR 不需要下载模型
   - 日志：`已启用 Windows OCR，跳过 tesseract.js 模型预加载`

2. **预加载已在进行中**
   - 避免重复加载
   - 静默跳过

3. **预加载已完成**
   - workers 已缓存
   - 静默跳过

4. **浏览器不支持 tesseract.js**
   - 静默跳过

---

## 代码实现

### 1. 核心变量

```javascript
let preloadedWorkers = null;  // 全局缓存预加载的 workers
let preloadProgress = {
    loading: false,    // 是否正在加载
    complete: false,   // 是否已完成
    error: null        // 加载错误信息
};
```

### 2. 核心函数

#### `startPreloadOcrModel()`
```javascript
async function startPreloadOcrModel() {
    // 检查各种跳过条件
    if (preloadProgress.loading || preloadProgress.complete || !window.Tesseract) {
        return;
    }
    
    if (window.feini && window.feini.ocr && isWindowsOcrEnabled()) {
        log('已启用 Windows OCR，跳过 tesseract.js 模型预加载', 'info');
        return;
    }
    
    preloadProgress.loading = true;
    
    // 创建多个 workers（并行处理）
    const cores = navigator.hardwareConcurrency || 4;
    const POOL = Math.min(4, Math.max(2, Math.floor(cores / 2)));
    
    const workers = [];
    for (let i = 0; i < POOL; i++) {
        const worker = await createWorkerWithProgress(i);
        workers.push(worker);
    }
    
    // 缓存到全局
    preloadedWorkers = workers;
    preloadProgress.complete = true;
    
    log(`✓ OCR 模型预加载完成！已准备 ${POOL} 个 worker`, 'success');
}
```

#### `initOcrAdapter()` 修改
```javascript
async function initOcrAdapter(btnEl) {
    // ... Windows OCR 逻辑 ...
    
    // 优先使用预加载的 workers
    if (preloadedWorkers && preloadedWorkers.length && preloadProgress.complete) {
        log(`▶ 使用 tesseract.js（已预加载，${preloadedWorkers.length} 个 worker 就绪）`, 'success');
        const workers = preloadedWorkers;
        preloadedWorkers = null;  // 清空缓存，避免重复使用
        
        return {
            kind: 'tesseract',
            label: 'tesseract.js (预加载)',
            poolSize: workers.length,
            workers,
            recognize: async (canvas, opts) => { /* ... */ },
            terminate: async () => { /* ... */ }
        };
    }
    
    // 未预加载，即时创建
    log('▶ 使用 tesseract.js，首次会下载中文模型', 'info');
    // ... 即时创建逻辑 ...
}
```

---

## 使用说明

### 对于用户

#### 推荐启用的场景
✅ **强烈推荐**：
- 网速较快（下载30MB不会等待太久）
- 经常使用 PDF 识别功能
- 需要快速响应，不想等待首次加载

✅ **可选启用**：
- 偶尔使用 PDF 识别
- 网速一般（后台下载不影响其他操作）

❌ **不推荐启用**：
- 流量有限（移动热点、按流量计费）
- 网速很慢（预加载会占用带宽）
- 只使用 Windows OCR（EXE 环境）

#### 操作步骤
1. 打开应用（EXE 或浏览器）
2. 找到 PDF 识别区域的 **⚡ 预加载模型** 开关
3. 点击开启：
   - 开关变为绿色
   - 终端显示：`已启用 OCR 模型预加载`
   - 后台开始下载模型（查看终端进度）
4. 等待预加载完成（通常30秒-2分钟）
   - 终端显示：`✓ OCR 模型预加载完成！`
5. 之后首次识别 PDF 时，无需等待，立即开始

#### 状态查看
- **终端日志**：实时显示预加载进度
  ```
  ⚡ 开始预加载 tesseract.js 模型（后台进行，不影响其他操作）...
  预加载进度 [Worker 1/2]: loading tesseract core 25%
  预加载进度 [Worker 1/2]: loading language traineddata 50%
  预加载进度 [Worker 2/2]: initializing tesseract 75%
  ✓ OCR 模型预加载完成！已准备 2 个 worker，首次识别将无需等待
  ```

- **识别时日志**：
  ```
  # 使用预加载的 workers
  ▶ 使用 tesseract.js（已预加载，2 个 worker 就绪）
  
  # 未预加载，即时创建
  ▶ 使用 tesseract.js（浏览器内 OCR），首次会下载中文模型
  ```

---

## 技术细节

### 1. 预加载时机
```javascript
// 在 DOMContentLoaded 事件中检查并启动
window.addEventListener('DOMContentLoaded', () => {
    // ... 其他初始化 ...
    initPreloadOcrToggle();  // 检查开关状态并启动预加载
});

function initPreloadOcrToggle() {
    const shouldPreload = localStorage.getItem('preloadOcrModel') === '1';
    document.getElementById('preloadOcrToggle').checked = shouldPreload;
    
    if (shouldPreload) {
        startPreloadOcrModel();  // 启动预加载
    }
}
```

### 2. Worker 池大小
```javascript
// 根据 CPU 核心数动态调整
const cores = navigator.hardwareConcurrency || 4;
const POOL = Math.min(4, Math.max(2, Math.floor(cores / 2)));

// 示例：
// 2 核 CPU → 2 个 workers
// 4 核 CPU → 2 个 workers
// 8 核 CPU → 4 个 workers
// 16 核 CPU → 4 个 workers (上限)
```

### 3. 进度日志优化
```javascript
// 只在关键进度点输出日志，避免刷屏
if (pct % 25 === 0 || pct === 100) {
    log(`预加载进度 [Worker ${index + 1}/${POOL}]: ${m.status} ${pct}%`, 'info');
}

// 输出示例：
// 预加载进度 [Worker 1/2]: loading tesseract core 25%
// 预加载进度 [Worker 1/2]: loading tesseract core 50%
// 预加载进度 [Worker 1/2]: loading tesseract core 75%
// 预加载进度 [Worker 1/2]: loading tesseract core 100%
```

### 4. 内存管理
```javascript
// 使用后清空缓存，避免内存泄漏
if (preloadedWorkers && preloadedWorkers.length && preloadProgress.complete) {
    const workers = preloadedWorkers;
    preloadedWorkers = null;  // 清空全局缓存
    
    return {
        workers,  // 返回给 adapter 使用
        // ...
    };
}
```

---

## 性能对比

### 场景 1：首次使用 PDF 识别

#### 未启用预加载
```
用户点击"识别" → 等待 30-120 秒 → 开始识别
```
- ❌ 用户体验差
- ❌ 长时间等待
- ❌ 按钮显示"加载模型 XX%"

#### 启用预加载
```
页面加载时后台预加载 → 用户点击"识别" → 立即开始识别
```
- ✅ 用户体验好
- ✅ 无等待时间
- ✅ 按钮立即显示"识别中..."

### 场景 2：使用 Windows OCR

#### 预加载的智能跳过
```
检测到 Windows OCR 已启用 → 跳过 tesseract.js 预加载 → 不消耗流量
```
- ✅ 不浪费流量
- ✅ 不占用内存
- ✅ 智能判断

---

## 配置选项

### LocalStorage 键值
```javascript
// 预加载开关状态
localStorage.setItem('preloadOcrModel', '1');  // 启用
localStorage.setItem('preloadOcrModel', '0');  // 禁用

// Windows OCR 开关状态
localStorage.setItem('useWindowsOcr', '1');    // 启用
localStorage.setItem('useWindowsOcr', '0');    // 禁用
```

### 默认值
- `preloadOcrModel`: `'0'` (默认禁用，避免自动消耗流量)
- `useWindowsOcr`: `'0'` (默认禁用，兼容性考虑)

---

## 常见问题

### Q1: 预加载会消耗多少流量？
**A:** 约 **30MB**（中文模型 ~20MB + 英文模型 ~10MB）

### Q2: 预加载需要多长时间？
**A:** 取决于网速：
- 10 Mbps → 约 30 秒
- 5 Mbps → 约 60 秒
- 1 Mbps → 约 4-5 分钟

### Q3: 预加载失败怎么办？
**A:** 系统会自动降级：
- 预加载失败时，首次使用仍会即时创建 workers
- 终端显示警告：`⚠ OCR 模型预加载失败，首次使用时将重新加载`

### Q4: 同时启用 Windows OCR 和预加载会怎样？
**A:** 预加载会自动跳过：
- 检测到 Windows OCR 已启用
- 不会预加载 tesseract.js 模型
- 日志：`已启用 Windows OCR，跳过 tesseract.js 模型预加载`

### Q5: 关闭页面后预加载的数据会保留吗？
**A:** 不会：
- 预加载的 workers 存在内存中
- 关闭页面后会被释放
- 下次打开需要重新预加载

### Q6: 预加载会影响页面加载速度吗？
**A:** 影响很小：
- 预加载在后台异步进行
- 不阻塞页面渲染和其他操作
- 用户可以正常使用其他功能

---

## 更新日志

- **2026-06-09**: 初始版本发布
  - 添加预加载模型开关
  - 实现后台异步预加载
  - 智能跳过逻辑
  - 进度日志输出

---

## 建议与最佳实践

### 推荐配置组合

#### 配置 1：Windows 用户 (EXE)
```
✅ Windows OCR: 开启
❌ 预加载模型: 关闭
```
**理由**: Windows OCR 更快，不需要 tesseract.js

#### 配置 2：浏览器用户 (网速快)
```
❌ Windows OCR: 关闭 (不可用)
✅ 预加载模型: 开启
```
**理由**: 预加载后首次识别无需等待

#### 配置 3：浏览器用户 (网速慢/流量有限)
```
❌ Windows OCR: 关闭 (不可用)
❌ 预加载模型: 关闭
```
**理由**: 避免自动消耗流量，按需加载

#### 配置 4：对比测试
```
✅ Windows OCR: 开启
✅ 预加载模型: 开启
```
**理由**: 两种引擎都可用，可切换对比效果

---

如有问题或建议，请联系开发团队。
