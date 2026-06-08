# sixel-web

[English](README.md) | [简体中文](README_zh.md)

---

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.1.0-green.svg)]()

> Browser-based Sixel image encoder & decoder — zero server dependency, pure frontend.

## Table of Contents

- [Introduction](#introduction)
- [Features](#features)
- [Usage](#usage)
- [Project Structure](#project-structure)
- [Known Issues](#known-issues)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## Introduction

**sixel-web** is a web-based tool for converting images to and from the [Sixel](https://en.wikipedia.org/wiki/Sixel) graphics format, originally defined for DEC VT terminals. It runs entirely in the browser — no server, no upload, no installation required.

Sixel is a bitmap graphics format supported by modern terminal emulators such as Windows Terminal, WezTerm, kitty, and xterm. sixel-web provides both an encoder (image → Sixel) and a decoder (Sixel → image) in a single HTML page.

## Features

### Image → Sixel Encoder

- **Quantization**: Median Cut (default) or PNN (high quality)
- **Dithering**: Floyd-Steinberg error diffusion (default), Bayer ordered, or none
- **Encryption**: Optional AES-256-GCM encryption with password (PBKDF2 key derivation)
- **Batch encoding**: Folder selection with recursive scanning, ZIP download with directory structure
- **Settings persistence**: All options saved to localStorage, restored on reload

### Sixel → Image Decoder

- Full state-machine parser compatible with img2sixel and pysixel output
- Automatic detection of encrypted files (SXL1 magic bytes), password prompt for decryption
- Single file, folder selection, or ZIP import for batch decoding
- Batch decode with password caching (enter once, reuse for all encrypted files)
- Thumbnail preview grid with individual or batch ZIP export

### Parameter Guide

#### Quality Mode

| Mode | Quantization | Dithering | Resolution | Histogram | Use Case |
|------|-------------|-----------|------------|-----------|----------|
| **auto** | Median Cut | User choice (default: FS) | User choice | 50K sample | Daily use, balanced speed/quality |
| **low** | Median Cut | User choice | User choice | 50K sample | Batch processing, previews |
| **high** | PNN | Auto-enables FS if none | Original (no resize) | Full image | High-fidelity photos, match img2sixel quality |

- **auto**: Median Cut quantization with 50,000-pixel histogram sampling. Fast and sufficient for most images.
- **low**: Same as auto currently. Reserved for future fast-mode optimizations.
- **high**: Forces PNN quantization (better gradients and skin tones), Floyd-Steinberg dithering, 256 colors, and original resolution. PNN is 2-5× slower than Median Cut but produces noticeably better results on photos with smooth gradients.

#### Dithering Algorithm

| Mode | Stage | Speed | Quality | Artifacts |
|------|-------|-------|---------|-----------|
| **None** | — | Fastest | Lowest | Hard color bands in gradients |
| **Bayer** | Pre-quantization | Fast | Medium | Visible 8×8 grid pattern in dark areas |
| **Floyd-Steinberg** | Post-quantization | Medium | Highest | Smooth gradients, no regular pattern |

- **None**: Direct nearest-color mapping. Suitable for screenshots and images with few colors.
- **Bayer**: Adds an 8×8 threshold matrix before quantization. Faster but produces visible grid textures in smooth gradients.
- **Floyd-Steinberg**: Propagates quantization error to neighboring pixels after quantization. Best quality, especially in dark/gradient areas. Recommended for photos.

#### Encoding Strategy

| Strategy | RLE Threshold | Speed | File Size | Use Case |
|----------|--------------|-------|-----------|----------|
| **auto** | ≥ 4 | Medium | Medium | Default, balanced |
| **fast** | Skip RLE entirely | Fastest | Largest | Real-time preview, terminal output |
| **size** | ≥ 2 | Slower | Smallest | Network transfer, storage |

- **auto**: Uses RLE compression when 4+ consecutive identical characters appear. `!Nc` format saves space only when the run length exceeds the format overhead (3 bytes).
- **fast**: Disables RLE entirely. Every Sixel character is output verbatim. Fastest encoding but largest file size.
- **size**: Uses RLE for runs of 2+ characters. Smallest output but slower due to more RLE operations.

#### Other Options

| Option | Default | Description |
|--------|---------|-------------|
| Colors | 256 | Palette size (2-256). Fewer colors = smaller files but lower quality |
| Keep Resolution | ✅ | Preserve original image dimensions. Uncheck to set max column width |
| Password | (empty) | Optional encryption password. Leave empty for no encryption. Any characters accepted |
| 8-bit DCS | ❌ | Use `0x90` instead of `ESC P`. Only for VT240-era terminals |
| GRI ≤255 | ❌ | Limit RLE repeat count to 255. Only for VT240-era terminals |

For detailed technical explanations, see [docs/technologies-and-algorithms.md](docs/technologies-and-algorithms.md).

## Performance

Inspired by libsixel's C implementation, the following optimizations have been applied:

| Optimization | Impact | Description |
|---|---|---|
| FS color lookup cache | 5–10× on FS stage | 15-bit R5G5B5 `Uint16Array(32768)` cache; first lookup O(256), subsequent O(1) |
| 15-bit flat histogram | 2–3× on quantize | `Uint16Array(32768)` replaces `Map`; zero GC overhead |
| Luminosity-weighted split | Quality improvement | ITU-R BT.601 weighting (R×0.299, G×0.587, B×0.114) for Median Cut dimension selection |
| Histogram sampling | 1.5–2× for large images | Median Cut samples 50,000 pixels for palette selection; PNN uses full image |
| Auto-disable FS | Skips when unnecessary | Floyd-Steinberg is skipped when **original** unique colors ≤ palette size (quantization is lossless) |

For a detailed analysis of libsixel's optimization techniques, see [docs/libsixel-optimizations.md](docs/libsixel-optimizations.md).

## Usage

Open `index.html` in any modern browser. No build step, no dependencies.

```
sixel-web/
├── index.html          # Entry point — open this file
├── favicon.svg         # SVG favicon
├── css/style.css       # Styles
├── js/
│   ├── app.js          # UI logic, batch processing, ZIP I/O
│   ├── crypto.js       # AES-256-GCM encryption/decryption
│   ├── quantize.js     # PNN and Median Cut quantization
│   ├── sixel-encoder.js # Sixel encoder
│   └── sixel-decoder.js # Sixel decoder (state machine)
└── test/               # Test files
```

### Encoding an Image

1. Open `index.html` in your browser
2. Configure options (quality mode, dithering, colors, resolution)
3. Optionally enter a password in the "加密" field to encrypt the output
4. Select one or more image files (PNG, JPEG, GIF, BMP, WebP), or click **"选择文件夹"** to batch encode
5. Click **"转换为 Sixel"**
6. Preview the result and download individually, or download all as ZIP

### Decoding a Sixel File

1. Switch to the **"Sixel → 图片"** tab
2. Drag and drop a `.six` file, select a folder, or import a ZIP archive
3. If the file is encrypted, a password dialog will appear automatically
4. View the decoded image(s) with thumbnail previews
5. Export as PNG/JPEG individually, or download all as ZIP

## Project Structure

```
sixel-web/
├── index.html              # Single-page application
├── favicon.svg             # SVG favicon
├── css/
│   └── style.css           # Responsive UI styles
├── js/
│   ├── app.js              # Application logic, batch processing, ZIP I/O
│   ├── crypto.js           # AES-256-GCM encryption/decryption
│   ├── quantize.js         # Color quantization (PNN + Median Cut)
│   ├── sixel-encoder.js    # Sixel protocol encoder
│   └── sixel-decoder.js    # Sixel protocol decoder (libsixel-compatible)
├── docs/
│   ├── libsixel-optimizations.md  # libsixel C optimization analysis
│   ├── technologies-and-algorithms.md  # Sixel, dithering, quantization explained
│   └── development-notes.md       # Development experience and lessons
├── test/                   # Test images and .six files
└── .gitignore
```

## Known Issues

- **Sixel decoding does not work on Firefox for Android.** The Sixel → Image decoder relies on `<label>` triggering a visually-hidden `<input type="file">`, which Firefox on Android does not support reliably. Encoding (Image → Sixel) works on all mobile browsers. Tested: Edge Mobile ✅, Chrome Mobile ✅, Firefox Mobile ❌.

## Acknowledgments

- [libsixel](https://github.com/saitoha/libsixel) — Reference Sixel implementation by Hayaki Saito. The decoder state machine and Floyd-Steinberg dithering algorithm are based on libsixel's `fromsixel.c` and `quant.c`.
- [chafa](https://github.com/hpjansson/chafa) — Terminal graphics library. The PNN quantization algorithm is inspired by chafa's approach.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
