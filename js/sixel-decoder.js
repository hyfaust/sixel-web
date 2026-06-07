/**
 * sixel-decoder.js — Sixel 解码器
 *
 * 基于 libsixel 1.8.7 fromsixel.c 和 sixel2png.py 的状态机实现
 * 兼容 img2sixel (\x1bPq) 和 pysixel (\x1bP0;0;0q) 两种 DCS 头格式
 * 支持 HLS 和 RGB 颜色定义、光栅属性、RLE 压缩
 */
(function () {
    'use strict';

    // 状态常量
    var PS_GROUND   = 0;
    var PS_ESC      = 1;
    var PS_DCS      = 2;
    var PS_DECSIXEL = 3;
    var PS_DECGRA   = 4;
    var PS_DECGRI   = 5;
    var PS_DECGCI   = 6;

    // 默认调色板（与 libsixel 一致）
    var DEFAULT_PALETTE = [
        0x000000, 0x141450, 0x500D0D, 0x145014, 0x501450, 0x145050,
        0x505014, 0x353535, 0x1A1A1A, 0x21213C, 0x3C1A1A, 0x213C21,
        0x3C213C, 0x213C3C, 0x3C3C21, 0x505050
    ];

    var SIXEL_PALETTE_MAX = 256;

    function palval(n, a, m) {
        return Math.round((n * a + (m / 2)) / m);
    }

    function xrgb(r, g, b) {
        return (palval(r, 255, 100) << 16) + (palval(g, 255, 100) << 8) + palval(b, 255, 100);
    }

    function hlsToRgb(hue, lum, sat) {
        var min, max, r, g, b;
        if (sat === 0) {
            r = g = b = lum;
            return xrgb(r, g, b);
        }
        max = lum + sat * (1.0 - (lum > 50 ? (2 * (lum / 100.0) - 1.0) : -(2 * (lum / 100.0) - 1.0))) / 2.0;
        min = lum - sat * (1.0 - (lum > 50 ? (2 * (lum / 100.0) - 1.0) : -(2 * (lum / 100.0) - 1.0))) / 2.0;
        hue = ((hue + 240) % 360 + 360) % 360;
        var sector = Math.floor(hue / 60);
        switch (sector) {
            case 0: r = max; g = min + (max - min) * (hue / 60.0); b = min; break;
            case 1: r = min + (max - min) * ((120 - hue) / 60.0); g = max; b = min; break;
            case 2: r = min; g = max; b = min + (max - min) * ((hue - 120) / 60.0); break;
            case 3: r = min; g = min + (max - min) * ((240 - hue) / 60.0); b = max; break;
            case 4: r = min + (max - min) * ((hue - 240) / 60.0); g = min; b = max; break;
            case 5: r = max; g = min; b = min + (max - min) * ((360 - hue) / 60.0); break;
            default: r = g = b = 0; break;
        }
        return xrgb(Math.round(r), Math.round(g), Math.round(b));
    }

    /**
     * 解码 Sixel 字节数据为 RGBA 像素
     */
    function decodeSixel(sixelStr) {
        var len = sixelStr.length;
        var p = 0;

        // 解析器状态
        var state = PS_GROUND;
        var posX = 0, posY = 0;
        var maxX = 0, maxY = 0;
        var repeatCount = 1;
        var colorIndex = 15;
        var param = 0, nparams = 0;
        var params = new Array(16);
        var attributedPh = 0, attributedPv = 0;

        // 图像缓冲区（索引模式，动态扩展）
        var imgWidth = 1, imgHeight = 1;
        var imgData = new Uint8Array(1);

        // 调色板
        var palette = new Int32Array(SIXEL_PALETTE_MAX);
        for (var pi = 0; pi < 16; pi++) palette[pi] = DEFAULT_PALETTE[pi];
        var n = 16;
        for (var ri = 0; ri < 6; ri++) {
            for (var gi = 0; gi < 6; gi++) {
                for (var bi = 0; bi < 6; bi++) {
                    if (n < SIXEL_PALETTE_MAX) palette[n] = (ri * 51 << 16) + (gi * 51 << 8) + bi * 51;
                    n++;
                }
            }
        }
        for (var gi = 0; gi < 24; gi++) {
            if (n < SIXEL_PALETTE_MAX) palette[n] = (gi * 11 << 16) + (gi * 11 << 8) + gi * 11;
            n++;
        }
        for (; n < SIXEL_PALETTE_MAX; n++) palette[n] = 0xFFFFFF;

        var ncolors = 2;

        function imgResize(newW, newH) {
            var alt = new Uint8Array(newW * newH);
            var minH = Math.min(newH, imgHeight);
            var minW = Math.min(newW, imgWidth);
            for (var row = 0; row < minH; row++) {
                for (var col = 0; col < minW; col++) {
                    alt[row * newW + col] = imgData[row * imgWidth + col];
                }
            }
            imgData = alt;
            imgWidth = newW;
            imgHeight = newH;
        }

        function ensureSize(needW, needH) {
            var sw = imgWidth, sh = imgHeight;
            while (sw < needW) sw *= 2;
            while (sh < needH) sh *= 2;
            if (sw > imgWidth || sh > imgHeight) imgResize(sw, sh);
        }

        while (p < len) {
            var c = sixelStr.charCodeAt(p);

            switch (state) {
                case PS_GROUND:
                    if (c === 0x1B) { state = PS_ESC; }
                    else if (c === 0x90) { state = PS_DCS; param = -1; }
                    else if (c === 0x9C) { p = len; }
                    p++;
                    break;

                case PS_ESC:
                    if (c === 0x5C || c === 0x9C) { p = len; } // ST → 结束
                    else if (c === 0x50) { state = PS_DCS; param = -1; } // 'P' → DCS
                    p++;
                    break;

                case PS_DCS:
                    if (c === 0x1B) { state = PS_ESC; }
                    else if (c >= 0x30 && c <= 0x39) {
                        if (param < 0) param = 0;
                        param = param * 10 + (c - 0x30);
                    }
                    else if (c === 0x3B) {
                        if (param < 0) param = 0;
                        if (nparams < 16) params[nparams++] = param;
                        param = 0;
                    }
                    else if (c === 0x71) { // 'q'
                        if (param >= 0 && nparams < 16) params[nparams++] = param;
                        if (nparams > 0) {
                            var pn1 = params[0];
                            // pad 由 pn1 决定（此处简化，不影响解码）
                        }
                        nparams = 0;
                        state = PS_DECSIXEL;
                    }
                    p++;
                    break;

                case PS_DECSIXEL:
                    if (c === 0x1B) { state = PS_ESC; p++; }
                    else if (c === 0x22) { // '"'
                        param = 0; nparams = 0; state = PS_DECGRA; p++;
                    }
                    else if (c === 0x21) { // '!'
                        param = 0; nparams = 0; state = PS_DECGRI; p++;
                    }
                    else if (c === 0x23) { // '#'
                        param = 0; nparams = 0; state = PS_DECGCI; p++;
                    }
                    else if (c === 0x24) { // '$' CR
                        posX = 0; p++;
                    }
                    else if (c === 0x2D) { // '-' NL
                        posX = 0; posY += 6; p++;
                    }
                    else if (c >= 0x3F && c <= 0x7E) { // sixel 字符
                        ensureSize(posX + repeatCount, posY + 6);
                        if (colorIndex > ncolors) ncolors = colorIndex;
                        var bits = c - 0x3F;
                        if (bits === 0) {
                            posX += repeatCount;
                        } else if (repeatCount <= 1) {
                            var vmask = 0x01;
                            for (var i = 0; i < 6; i++) {
                                if (bits & vmask) {
                                    var pos = imgWidth * (posY + i) + posX;
                                    imgData[pos] = colorIndex;
                                    if (maxX < posX) maxX = posX;
                                    if (maxY < posY + i) maxY = posY + i;
                                }
                                vmask <<= 1;
                            }
                            posX++;
                        } else {
                            // repeatCount > 1
                            var vmask2 = 0x01;
                            var ii = 0;
                            while (ii < 6) {
                                if (bits & vmask2) {
                                    var nc = 1;
                                    var cm = vmask2 << 1;
                                    while (ii + nc < 6 && (bits & cm)) { nc++; cm <<= 1; }
                                    for (var y = posY + ii; y < posY + ii + nc; y++) {
                                        var off = imgWidth * y + posX;
                                        for (var k = 0; k < repeatCount; k++) imgData[off + k] = colorIndex;
                                    }
                                    var endX = posX + repeatCount - 1;
                                    var endY = posY + ii + nc - 1;
                                    if (maxX < endX) maxX = endX;
                                    if (maxY < endY) maxY = endY;
                                    ii += nc - 1;
                                    vmask2 <<= (nc - 1);
                                }
                                vmask2 <<= 1;
                                ii++;
                            }
                            posX += repeatCount;
                        }
                        repeatCount = 1;
                        p++;
                    }
                    else { p++; }
                    break;

                case PS_DECGRA: // 光栅属性 "Pan;Pad;Ph;Pv
                    if (c === 0x1B) { state = PS_ESC; p++; }
                    else if (c >= 0x30 && c <= 0x39) { param = param * 10 + (c - 0x30); p++; }
                    else if (c === 0x3B) {
                        if (nparams < 16) params[nparams++] = param;
                        param = 0; p++;
                    }
                    else {
                        if (nparams < 16) params[nparams++] = param;
                        if (nparams > 2 && params[2] > 0) attributedPh = params[2];
                        if (nparams > 3 && params[3] > 0) attributedPv = params[3];
                        if (imgWidth < attributedPh || imgHeight < attributedPv) {
                            ensureSize(Math.max(imgWidth, attributedPh), Math.max(imgHeight, attributedPv));
                        }
                        state = PS_DECSIXEL; param = 0; nparams = 0;
                        // 不递增 p，当前字符可能是 sixel
                    }
                    break;

                case PS_DECGRI: // RLE !Pn
                    if (c === 0x1B) { state = PS_ESC; p++; }
                    else if (c >= 0x30 && c <= 0x39) { param = param * 10 + (c - 0x30); p++; }
                    else {
                        repeatCount = param || 1;
                        if (repeatCount > 0xFFFF) repeatCount = 1;
                        state = PS_DECSIXEL; param = 0; nparams = 0;
                        // 不递增 p，当前字符是 sixel 数据
                    }
                    break;

                case PS_DECGCI: // 颜色 #Pc;Pu;Px;Py;Pz
                    if (c === 0x1B) { state = PS_ESC; p++; }
                    else if (c >= 0x30 && c <= 0x39) { param = param * 10 + (c - 0x30); p++; }
                    else if (c === 0x3B) {
                        if (nparams < 16) params[nparams++] = param;
                        param = 0; p++;
                    }
                    else {
                        state = PS_DECSIXEL;
                        if (nparams < 16) params[nparams++] = param;
                        param = 0;
                        if (nparams > 0) {
                            colorIndex = params[0];
                            if (colorIndex < 0) colorIndex = 0;
                            if (colorIndex >= SIXEL_PALETTE_MAX) colorIndex = SIXEL_PALETTE_MAX - 1;
                        }
                        if (nparams > 4) {
                            if (params[1] === 1) {
                                // HLS
                                palette[colorIndex] = hlsToRgb(
                                    Math.min(params[2], 360), Math.min(params[3], 100), Math.min(params[4], 100));
                            } else if (params[1] === 2) {
                                // RGB
                                palette[colorIndex] = xrgb(
                                    Math.min(params[2], 100), Math.min(params[3], 100), Math.min(params[4], 100));
                            }
                        }
                        // 不递增 p，当前字符可能是 sixel
                    }
                    break;
            }
        }

        // 收尾：裁剪到实际内容范围（与 libsixel 一致）
        maxX++;
        maxY++;
        if (maxX < attributedPh) maxX = attributedPh;
        if (maxY < attributedPv) maxY = attributedPv;
        if (maxX < 1) maxX = 1;
        if (maxY < 1) maxY = 1;
        if (imgWidth > maxX || imgHeight > maxY) {
            imgResize(maxX, maxY);
        }

        // 渲染为 RGBA
        var outW = imgWidth, outH = imgHeight;
        var pixels = new Uint8ClampedArray(outW * outH * 4);
        for (var i = 0; i < outW * outH; i++) {
            var rgb = palette[imgData[i]];
            pixels[i * 4]     = (rgb >> 16) & 0xFF;
            pixels[i * 4 + 1] = (rgb >> 8) & 0xFF;
            pixels[i * 4 + 2] = rgb & 0xFF;
            pixels[i * 4 + 3] = 255;
        }

        return { width: outW, height: outH, pixels: pixels };
    }

    function renderSixelToCanvas(sixelStr, canvas) {
        var result = decodeSixel(sixelStr);
        canvas.width = result.width;
        canvas.height = result.height;
        if (result.width > 0 && result.height > 0) {
            var ctx = canvas.getContext('2d');
            ctx.putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
        }
        return { width: result.width, height: result.height };
    }

    window.SixelDecoder = { decodeSixel: decodeSixel, renderSixelToCanvas: renderSixelToCanvas };
})();
