# sixel-web

[English](README.md) | [简体中文](README_zh.md)

---

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.1.1-green.svg)]()

> 基于浏览器的 Sixel 图片编码/解码工具 — 纯前端，零服务端依赖。

## 目录

- [简介](#简介)
- [功能特性](#功能特性)
- [使用方法](#使用方法)
- [项目结构](#项目结构)
- [已知问题](#已知问题)
- [致谢](#致谢)
- [许可证](#许可证)

## 简介

**sixel-web** 是一个基于浏览器的 [Sixel](https://en.wikipedia.org/wiki/Sixel) 图片格式转换工具。Sixel 是 DEC VT 终端定义的位图图形格式，被 Windows Terminal、WezTerm、kitty、xterm 等现代终端模拟器支持。sixel-web 在单个 HTML 页面中同时提供编码器（图片 → Sixel）和解码器（Sixel → 图片）。

完全在浏览器中运行 — 无需服务器、无需上传、无需安装。

## 功能特性

### 图片 → Sixel 编码器

- **量化算法**：Median Cut（默认）或 PNN（高质量）
- **抖动算法**：Floyd-Steinberg 误差扩散（默认）、Bayer 有序抖动、无抖动
- **加密**：可选 AES-256-GCM 密码加密（PBKDF2 密钥派生）
- **批量编码**：选择文件夹递归扫描并编码所有图片，输出保留目录结构
- **设置持久化**：所有选项保存至 localStorage，刷新页面后自动恢复

### Sixel → 图片解码器

- 完整状态机解析器，兼容 img2sixel 和 pysixel 输出
- 自动检测加密文件（SXL1 魔数），弹窗输入密码解密
- 单文件上传、选择文件夹（递归扫描）或导入 ZIP 文件
- 批量解码时密码缓存（输入一次，自动复用于所有加密文件）
- 带缩略图预览网格，支持逐个或 ZIP 打包导出

### 参数说明

#### 质量模式

| 模式 | 量化算法 | 抖动 | 分辨率 | 直方图 | 适用场景 |
|------|---------|------|--------|--------|---------|
| **auto** | Median Cut | 用户选择（默认 FS） | 用户选择 | 5 万像素采样 | 日常使用，速度与质量平衡 |
| **low** | Median Cut | 用户选择 | 用户选择 | 5 万像素采样 | 批量处理、预览 |
| **high** | PNN | 自动启用 FS（若无） | 原始（不缩放） | 全量像素 | 高保真照片、对标 img2sixel 质量 |

- **auto**：Median Cut 量化 + 5 万像素直方图采样。速度快，满足大多数图片需求。
- **low**：当前与 auto 相同，预留未来进一步提速的空间。
- **high**：强制使用 PNN 量化（渐变和肤色更准确）、Floyd-Steinberg 抖动、256 色、原始分辨率。PNN 比 Median Cut 慢 2-5 倍，但在照片渐变区域效果显著更好。

#### 抖动算法

| 模式 | 阶段 | 速度 | 质量 | 伪影 |
|------|------|------|------|------|
| **无** | — | 最快 | 最低 | 渐变区域出现硬边色带 |
| **Bayer** | 量化前 | 快 | 中等 | 暗部渐变可见 8×8 网格纹理 |
| **Floyd-Steinberg** | 量化后 | 中等 | 最高 | 渐变平滑，无规则纹理 |

- **无**：直接映射最近调色板色。适合截图和颜色较少的图片。
- **Bayer**：量化前叠加 8×8 阈值矩阵。速度更快，但暗部渐变会产生可见的网格纹理。
- **Floyd-Steinberg**：量化后将误差传播到相邻像素。质量最佳，尤其在暗部和渐变区域。推荐用于照片。

#### 编码策略

| 策略 | RLE 阈值 | 速度 | 文件体积 | 适用场景 |
|------|----------|------|---------|---------|
| **auto** | ≥ 4 | 中等 | 中等 | 默认，平衡 |
| **fast** | 完全跳过 RLE | 最快 | 最大 | 实时预览、终端直出 |
| **size** | ≥ 2 | 较慢 | 最小 | 网络传输、存储 |

- **auto**：连续 4 个以上相同字符时使用 RLE 压缩（`!Nc`）。`!Nc` 格式本身占 3 字节，仅在重复次数 ≥ 4 时才比逐字输出更短。
- **fast**：完全跳过 RLE，所有 Sixel 字符逐字输出。编码最快，但文件体积最大。
- **size**：连续 2 个以上相同字符即压缩。输出最小，但 RLE 操作更多，编码稍慢。

#### 其他选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| 调色板颜色数 | 256 | 调色板大小（2-256）。颜色越少文件越小，但质量越低 |
| 保持原始分辨率 | ✅ | 保持原图尺寸。取消勾选可设置最大列宽 |
| 加密密码 | （空） | 可选加密密码。留空则不加密，支持任意字符 |
| 8bit DCS | ❌ | 使用 `0x90` 代替 `ESC P`。仅 VT240 等老终端需要 |
| GRI ≤255 | ❌ | RLE 重复次数限制为 255。仅 VT240 等老终端需要 |

详细技术说明见 [docs/technologies-and-algorithms.md](docs/technologies-and-algorithms.md)。

## 性能优化

借鉴 libsixel 的 C 实现，已应用以下优化：

| 优化 | 收益 | 说明 |
|---|---|---|
| FS 颜色查找缓存 | FS 阶段 5–10× | 15-bit R5G5B5 `Uint16Array(32768)` 缓存，首次 O(256)，后续 O(1) |
| 15-bit 平坦直方图 | 量化阶段 2–3× | `Uint16Array(32768)` 替代 `Map`，零 GC 开销 |
| 亮度加权分割 | 质量提升 | ITU-R BT.601 权重（R×0.299, G×0.587, B×0.114）用于 Median Cut 维度选择 |
| 直方图采样 | 大图 1.5–2× | Median Cut 采样 50000 像素构建调色板；PNN 使用全量数据 |
| 自动禁用 FS | 无损时跳过 | 量化前唯一色数 ≤ 调色板大小时跳过 Floyd-Steinberg（量化本身无损） |

详细的 libsixel 性能分析见 [docs/libsixel-optimizations.md](docs/libsixel-optimizations.md)。

## 使用方法

在任意现代浏览器中打开 `index.html`，无需构建步骤，无依赖。

```
sixel-web/
├── index.html          # 入口文件 — 直接打开此文件
├── favicon.svg         # SVG 图标
├── css/style.css       # 样式
├── js/
│   ├── app.js          # 应用逻辑、批处理、ZIP 读写
│   ├── crypto.js       # AES-256-GCM 加密/解密
│   ├── quantize.js     # 颜色量化（PNN + Median Cut）
│   ├── sixel-encoder.js # Sixel 编码器
│   └── sixel-decoder.js # Sixel 解码器（兼容 libsixel）
└── test/               # 测试文件
```

### 编码图片

1. 在浏览器中打开 `index.html`
2. 配置选项（质量模式、抖动方式、颜色数、分辨率）
3. 可选：在"加密"输入框中输入密码以加密输出
4. 选择一个或多个图片文件（PNG、JPEG、GIF、BMP、WebP），或点击 **"选择文件夹"** 批量编码
5. 点击 **"转换为 Sixel"**
6. 预览结果，逐个下载或打包为 ZIP 下载

### 解码 Sixel 文件

1. 切换到 **"Sixel → 图片"** 标签页
2. 拖放 `.six` 文件、选择文件夹或导入 ZIP 压缩包
3. 如果文件已加密，会自动弹出密码输入弹窗
4. 查看解码图片（含缩略图预览）
5. 逐个导出 PNG/JPEG，或打包为 ZIP 下载

## 项目结构

```
sixel-web/
├── index.html              # 单页应用
├── favicon.svg             # SVG 图标
├── css/
│   └── style.css           # 响应式 UI 样式
├── js/
│   ├── app.js              # 应用逻辑、批处理、ZIP 读写
│   ├── crypto.js           # AES-256-GCM 加密/解密
│   ├── quantize.js         # 颜色量化（PNN + Median Cut）
│   ├── sixel-encoder.js    # Sixel 协议编码器
│   └── sixel-decoder.js    # Sixel 协议解码器（兼容 libsixel）
├── docs/
│   ├── libsixel-optimizations.md  # libsixel C 优化分析
│   ├── technologies-and-algorithms.md  # Sixel、抖动、量化技术详解
│   └── development-notes.md       # 开发经验与教训
├── test/                   # 测试图片和 .six 文件
└── .gitignore
```

## 已知问题

- **Sixel 解码在 Firefox Android 版上无法正常工作。** Sixel → 图片解码器依赖 `<label>` 触发视觉隐藏的 `<input type="file">`，Firefox Android 版对此支持不完善。编码功能（图片 → Sixel）在所有移动端浏览器上均可正常使用。测试结果：Edge Mobile ✅、Chrome Mobile ✅、Firefox Mobile ❌。

## 致谢

- [libsixel](https://github.com/saitoha/libsixel) — Hayaki Saito 开发的参考 Sixel 实现。解码器状态机和 Floyd-Steinberg 抖动算法基于 libsixel 的 `fromsixel.c` 和 `quant.c`。
- [chafa](https://github.com/hpjansson/chafa) — 终端图形库。PNN 量化算法受 chafa 的实现启发。

## 许可证

本项目基于 [GNU 通用公共许可证 v3.0](LICENSE) 发布。
