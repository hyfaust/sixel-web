# sixel-web

[English](README.md) | [简体中文](README_zh.md)

---

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)]()

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

- **量化算法**：Median Cut（默认）和 PNN（Pairwise Nearest Neighbor，高质量）
- **抖动模式**：Floyd-Steinberg 误差扩散（默认）、Bayer 有序抖动、无抖动
- **质量预设**：auto（平衡）、low（快速）、high（256色 + PNN + FS 抖动）
- **分辨率控制**：保持原始分辨率或设置最大列宽
- **编码策略**：auto（平衡）、fast（跳过 RLE）、size（更小体积）
- **可选标志**：8-bit DCS、GRI ≤255（VT240 兼容）
- **设置持久化**：所有选项保存至 localStorage，刷新页面后自动恢复

### Sixel → 图片解码器

- 完整状态机解析器，兼容 img2sixel 和 pysixel 输出
- 支持光栅属性、HLS 和 RGB 颜色定义、RLE 压缩
- 拖放或点击上传 `.six` 文件
- 导出解码图片为 PNG 或 JPEG

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
├── css/style.css       # 样式
├── js/
│   ├── app.js          # UI 逻辑、预处理流水线
│   ├── quantize.js     # PNN 和 Median Cut 量化
│   ├── sixel-encoder.js # Sixel 编码器
│   └── sixel-decoder.js # Sixel 解码器（状态机）
└── test/               # 测试文件
```

### 编码图片

1. 在浏览器中打开 `index.html`
2. 配置选项（质量模式、抖动方式、颜色数、分辨率）
3. 选择一个或多个图片文件（PNG、JPEG、GIF、BMP、WebP）
4. 点击 **"转换为 Sixel"**
5. 预览结果并下载 `.six` 文件

### 解码 Sixel 文件

1. 切换到 **"Sixel → 图片"** 标签页
2. 拖放 `.six` 文件，或点击选择文件
3. 查看解码图片，导出为 PNG 或 JPEG

## 项目结构

```
sixel-web/
├── index.html              # 单页应用
├── css/
│   └── style.css           # 响应式 UI 样式
├── js/
│   ├── app.js              # 应用逻辑与预处理流水线
│   ├── quantize.js         # 颜色量化（PNN + Median Cut）
│   ├── sixel-encoder.js    # Sixel 协议编码器
│   └── sixel-decoder.js    # Sixel 协议解码器（兼容 libsixel）
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
