# sixel-web

[English](README.md) | [简体中文](README_zh.md)

---

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)]()

> Browser-based Sixel image encoder & decoder — zero server dependency, pure frontend.

## Table of Contents

- [Introduction](#introduction)
- [Features](#features)
- [Usage](#usage)
- [Project Structure](#project-structure)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## Introduction

**sixel-web** is a web-based tool for converting images to and from the [Sixel](https://en.wikipedia.org/wiki/Sixel) graphics format, originally defined for DEC VT terminals. It runs entirely in the browser — no server, no upload, no installation required.

Sixel is a bitmap graphics format supported by modern terminal emulators such as Windows Terminal, WezTerm, kitty, and xterm. sixel-web provides both an encoder (image → Sixel) and a decoder (Sixel → image) in a single HTML page.

## Features

### Image → Sixel Encoder

- **Quantization algorithms**: Median Cut (default) and PNN (Pairwise Nearest Neighbor, high quality)
- **Dithering modes**: Floyd-Steinberg error diffusion (default), Bayer ordered dithering, or none
- **Quality presets**: auto (balanced), low (fast), high (256 colors + PNN + FS dithering)
- **Resolution control**: Keep original resolution or set a maximum column width
- **Encoding policies**: auto (balanced), fast (skip RLE), size (smaller output)
- **Optional flags**: 8-bit DCS, GRI ≤255 (VT240 compatibility)
- **Settings persistence**: All options saved to localStorage, restored on reload

### Sixel → Image Decoder

- Full state-machine parser compatible with both img2sixel and pysixel output
- Supports raster attributes, HLS and RGB color definitions, RLE compression
- Drag-and-drop or click to upload `.six` files
- Export decoded image as PNG or JPEG

## Usage

Open `index.html` in any modern browser. No build step, no dependencies.

```
sixel-web/
├── index.html          # Entry point — open this file
├── css/style.css       # Styles
├── js/
│   ├── app.js          # UI logic, preprocessing pipeline
│   ├── quantize.js     # PNN and Median Cut quantization
│   ├── sixel-encoder.js # Sixel encoder
│   └── sixel-decoder.js # Sixel decoder (state machine)
└── test/               # Test files
```

### Encoding an Image

1. Open `index.html` in your browser
2. Configure options (quality mode, dithering, colors, resolution)
3. Select one or more image files (PNG, JPEG, GIF, BMP, WebP)
4. Click **"转换为 Sixel"** (Convert to Sixel)
5. Preview the result and download the `.six` file

### Decoding a Sixel File

1. Switch to the **"Sixel → 图片"** tab
2. Drag and drop a `.six` file, or click to select
3. View the decoded image and export as PNG or JPEG

## Project Structure

```
sixel-web/
├── index.html              # Single-page application
├── css/
│   └── style.css           # Responsive UI styles
├── js/
│   ├── app.js              # Application logic & preprocessing pipeline
│   ├── quantize.js         # Color quantization (PNN + Median Cut)
│   ├── sixel-encoder.js    # Sixel protocol encoder
│   └── sixel-decoder.js    # Sixel protocol decoder (libsixel-compatible)
├── test/                   # Test images and .six files
└── .gitignore
```

## Acknowledgments

- [libsixel](https://github.com/saitoha/libsixel) — Reference Sixel implementation by Hayaki Saito. The decoder state machine and Floyd-Steinberg dithering algorithm are based on libsixel's `fromsixel.c` and `quant.c`.
- [chafa](https://github.com/hpjansson/chafa) — Terminal graphics library. The PNN quantization algorithm is inspired by chafa's approach.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
