# 开发经验与教训

Sixel-Web 从零到完整功能的开发过程中积累的经验总结。

---

## 1. 性能优化

### 1.1 数据结构选择至关重要

**教训**：`Map` 在高频场景下开销远超 `TypedArray`。

直方图构建最初使用 `Map<key, count>`，每次插入都有哈希计算和 GC 压力。改为 `Uint16Array(32768)` 平坦数组后，量化阶段提速 2-3 倍。

```
Map 版本:    histogram.set(key, (histogram.get(key) || 0) + 1)
TypedArray:  hist[hash]++  (if < 65535)
```

**原则**：当 key 空间有限且可枚举时，优先使用平坦数组。

### 1.2 查找缓存消除重复计算

FS 误差扩散中，每个像素都需要查找最近调色板色（O(256)）。通过 15-bit R5G5B5 哈希缓存表，大部分像素只需 O(1) 查找。

```
首次:  遍历 256 色 → 找到最佳 → 写入 cache[hash]
后续:  cache[hash] → 命中 → O(1) 返回
```

**收益**：FS 阶段提速 5-10 倍。

### 1.3 采样策略

libsixel 的 `computeHistogram` 根据质量模式限制采样数（LOW=18K, HIGH=1.1M）。Median Cut 对 50000 像素采样构建直方图，PNN 使用全量数据保证精度。

**原则**：量化是近似算法，采样不影响最终调色板质量，但大幅减少计算量。

### 1.4 不要盲目跳过计算

**教训**：优化6（自动禁用 FS）最初检查**量化后**的唯一色数，导致几乎每次都跳过 FS。

```javascript
// 错误: 量化后唯一色数几乎永远 ≤ 256
if (new Set(result.pixels).size > maxColors) { ... }

// 正确: 检查量化前的原始唯一色数
if (result.histEntries > maxColors) { ... }
```

**原则**：优化的前置条件必须基于正确的判断时机。

---

## 2. 抖动算法

### 2.1 Bayer vs Floyd-Steinberg

Bayer 有序抖动在量化**前**叠加固定矩阵，FS 误差扩散在量化**后**逐像素传播误差。

```
Bayer:  原图 → 叠加 8×8 矩阵 → 量化 → 输出
FS:     原图 → 量化 → 逐像素: 计算误差 → 传播到相邻像素 → 输出
```

FS 在暗部渐变和平滑过渡上全面优于 Bayer，且计算量可接受（配合查找缓存）。

### 2.2 两者不应叠加

Bayer 先扭曲输入，FS 再对已扭曲的结果做误差扩散。FS 会试图修正 Bayer 引入的偏移，但 Bayer 的规则图案干扰 FS 的误差传播方向，效果反而更差。

---

## 3. 量化算法

### 3.1 Median Cut 维度选择

**教训**：纯 RGB 范围选择（`rangeR >= rangeG`）不符合人眼感知。绿色范围最大时总是优先分割绿色通道，导致红色和蓝色细节丢失。

改用 ITU-R BT.601 亮度加权后（R×0.299, G×0.587, B×0.114），调色板分配更符合人眼感知。

### 3.2 PNN 的 bin 合并陷阱

PNN 合并 bin 后，其他 bin 的 `nn`（最近邻索引）可能指向已删除的 bin。必须在合并后修复所有指向被删除 bin 的 `nn` 指针。

```javascript
// 合并 binI 到 binJ 后
bins[bestI] = null;
for (var j = 0; j < bins.length; j++) {
    if (bins[j] && bins[j].nn === bestI) {
        bins[j].nn = bestJ;  // 重定向到合并后的 bin
    }
}
```

**教训**：数据结构中的引用关系在修改后必须同步更新。

---

## 4. Sixel 编码

### 4.1 RLE 阈值

`!Nc` 格式本身需要至少 3 字符（`!` + 数字 + 字符）。当 run ≤ 3 时，逐字输出比 RLE 更短。libsixel 的阈值是 3（`save_count > 3` 才用 RLE）。

### 4.2 整数转字符串的陷阱

**教训**：自实现的 `pushNum` 函数对小数字（如 run=5）输出 `"0005"` 而非 `"5"`，导致解码器解析错误。`String(n)` 虽然慢但保证正确性。

```javascript
// 错误实现（总是输出4位）
function pushNum(out, n) {
    if (n >= 1000) out.push(0x30 + (n / 1000 | 0));
    // ... 总是执行所有分支
}

// 正确实现（跳过前导零）
function pushNum(out, n) {
    if (n >= 1000) { out.push(0x30 + (n / 1000 | 0)); n %= 1000; }
    if (n >= 100)  { out.push(0x30 + (n / 100 | 0));  n %= 100; }
    if (n >= 10)   { out.push(0x30 + (n / 10 | 0));   n %= 10; }
    out.push(0x30 + n);
}
```

**原则**：编码/解码的格式必须严格对称，任何偏差都会导致数据损坏。

---

## 5. 解码器

### 5.1 状态机 vs 正则解析

**教训**：最初的解码器使用 `indexOf('q')` 提取 body 后线性扫描。虽然对大多数文件有效，但无法正确处理嵌入的 ESC 序列和边界情况。

改为与 libsixel 一致的 7 状态机后，兼容性大幅提升。

```
PS_GROUND → PS_ESC → PS_DCS → PS_DECSIXEL → PS_DECGRA/PS_DECGRI/PS_DECGCI
```

**原则**：协议解析器应忠实于规范实现，而非走捷径。

### 5.2 像素缓冲区初始化

**教训**：解码器初始化为白色 `[255,255,255,255]`，但 img2sixel 的某些文件中未被任何颜色覆盖的像素应为黑色。改为索引缓冲区（`Uint8Array`）+ 调色板渲染后，正确匹配 libsixel 行为。

---

## 6. 浏览器兼容性

### 6.1 移动端文件输入

**教训**：`display:none` 的 `<input type="file">` 在 iOS Safari 上无法通过 JS `.click()` 触发 `change` 事件。MDN 推荐使用 `opacity:0` + 绝对定位或 `<label>` 元素。

```html
<!-- 不可靠 -->
<input type="file" style="display:none">

<!-- 推荐 -->
<input type="file" class="visually-hidden">
<label for="file-input">选择文件</label>
```

```css
.visually-hidden {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
```

### 6.2 `accept` 属性

**教训**：`accept="*/*"` 不是 MDN 规定的有效值。有效值为：特定扩展名（`.jpg`）、特定 MIME 类型（`image/png`）、通配符类别（`image/*`）。无效值在移动端可能产生不可预测行为。

### 6.3 Promise 错误处理

**教训**：`readFileAsText(file).then(...)` 如果没有 `.catch()`，Promise rejection 被静默吞掉，用户看到的是"完全没有反应"。

```javascript
// 错误: 无 .catch()
readFileAsText(file).then(function (text) { ... });

// 正确: 添加错误处理
readFileAsText(file)
    .then(function (text) { ... })
    .catch(function (e) { showError('文件读取失败: ' + e.message); });
```

### 6.4 Latin-1 vs UTF-8 解码

**教训**：`FileReader.readAsText()` 默认 UTF-8 解码，会破坏 Sixel 文件中的非 ASCII 字节。应使用 `readAsArrayBuffer()` + 手动 Latin-1 转换。

```javascript
// 错误: UTF-8 可能破坏二进制数据
reader.readAsText(file);

// 正确: 逐字节映射
reader.readAsArrayBuffer(file);
// onload: new TextDecoder('iso-8859-1').decode(reader.result)
```

### 6.5 Firefox Mobile 的 `<label>` 问题

`<label for="file-input">` 触发视觉隐藏的 `<input>` 在 Firefox Android 上不可靠，Chrome/Edge/Safari 正常。这是浏览器引擎差异，暂无完美解决方案。

---

## 7. ZIP 文件处理

### 7.1 零依赖实现

自实现 ZIP 写入器（~120 行）和读取器（~80 行），避免引入 JSZip 等外部依赖。

- 写入器：仅 Store 模式（无压缩），对 .six 文本文件体积影响小
- 读取器：支持 Store + Deflate（使用 `DecompressionStream` API）

### 7.2 路径编码

ZIP 文件名默认使用 Code Page 437 编码，非 ASCII 字符会乱码。设置 General Purpose Bit Flag 的 bit 11（`0x0800`）声明 UTF-8 编码。

```javascript
lv.setUint16(6, 0x0800, true);  // flags: UTF-8
```

### 7.3 CRC32 实现

标准 CRC32 查找表（256 项）只需初始化一次，后续查找 O(1)。多项式 `0xEDB88320`（反转形式）。

---

## 8. 工程实践

### 8.1 缓存版本控制

HTML 中引用的 JS/CSS 文件使用 `?v=N` 查询参数做缓存失效。每次修改文件后递增版本号，确保用户浏览器加载最新版本。

### 8.2 IIFE 模块隔离

所有 JS 文件使用 IIFE（`(function(){...})()`）包裹，通过 `window.XXX` 暴露公共 API。避免全局变量污染和变量重声明错误。

### 8.3 localStorage 设置持久化

```javascript
// 保存: 检测 input 类型
data[id] = el.type === 'checkbox' ? el.checked : el.value;

// 恢复: 同样检测类型
if (el.type === 'checkbox') el.checked = !!data[id];
else el.value = data[id];
```

### 8.4 渐进式优化策略

分批实施优化，每批测试通过后再提交。这使得问题定位变得简单——如果某批引入了质量退化，可以精确定位到具体优化项。

**实际案例**：优化 7（RLE pushNum）导致编码质量损坏。由于是单独提交，可以精确回退而不影响其他优化。

---

## 9. 测试策略

### 9.1 对比测试

将 web-sixel 的输出与 img2sixel（libsixel C 实现）对比，是最有效的质量验证方法。差异意味着我们的实现有改进空间。

### 9.2 边界情况

- 纯白/纯黑图片（单一颜色，FS 应被跳过）
- 大图片（测试内存和性能）
- 小图片（测试自适应逻辑）
- 多色图片（测试量化质量）
- 移动端浏览器（测试兼容性）

### 9.3 手动刷新缓存

开发时必须 `Ctrl+Shift+R` 强制刷新，否则浏览器可能使用缓存的旧版本 JS 文件，导致"修改无效"的错觉。

---

## 10. 加密功能

### 10.1 加密文件格式设计

使用 4 字节魔数 `SXL1` 标识加密文件，解码时自动检测。这种设计实现了完全向后兼容：普通 .six 文件正常解码，加密文件弹窗提示输入密码。

```
Magic("SXL1") + Salt(16B) + IV(12B) + Ciphertext + AuthTag(16B)
```

**教训**：最初考虑过在 Sixel 文本中嵌入加密标记，但二进制加密数据会破坏 Sixel 协议的文本结构。改为在 Sixel 数据外层包裹加密 header，保持了格式的独立性。

### 10.2 PBKDF2 密钥派生

使用 Web Crypto API 的 `crypto.subtle.deriveKey` 从密码派生 AES-256 密钥。每次加密生成新的随机 Salt（16 字节）和 IV（12 字节），防止彩虹表攻击和密文重放。

**教训**：不要自己实现 PBKDF2，浏览器原生实现经过安全审计且性能更好。

### 10.3 CSS 选择器与动态 type 切换

密码输入框的"显示/隐藏"功能通过切换 `type="password"` ↔ `type="text"` 实现。

**教训**：CSS 选择器 `input[type="password"]` 只匹配 `password` 类型，切换为 `text` 后样式丢失导致输入框缩窄。必须同时匹配两种类型：

```css
.password-group input[type="password"],
.password-group input[type="text"] {
    flex: 1; /* ... */
}
```

### 10.4 批量解密的密码缓存

批量解码时，首个加密文件弹窗输入密码后缓存，后续加密文件自动复用。非加密文件正常解码，无需密码。

**设计决策**：缓存仅在单次批量操作内有效，不持久化到 localStorage（安全考虑）。

### 10.5 Web Crypto API 限制

`crypto.subtle` 仅在安全上下文（HTTPS 或 localhost）中可用。在 HTTP 远程访问时加密功能不可用，但不影响其他功能。
