/**
 * sixel-decoder.js — Sixel 解码器
 */
(function () {
    'use strict';

    /**
     * 解码 Sixel 文本为 RGBA 像素
     */
    function decodeSixel(sixelStr) {
        var palette = [];
        for (var pi = 0; pi < 256; pi++) palette.push([0, 0, 0]);

        var width = 0, height = 0;

        // 光栅属性: "Pan;Pad;Ph;Pv
        var rasterMatch = sixelStr.match(/"(\d+);(\d+);(\d+);(\d+)/);
        if (rasterMatch) {
            width = parseInt(rasterMatch[3]);
            height = parseInt(rasterMatch[4]);
        }

        // 提取 body (DCS q ... ST)
        var bodyStart = sixelStr.indexOf('q');
        if (bodyStart === -1) return { width: 0, height: 0, pixels: new Uint8ClampedArray(0) };
        bodyStart++;

        var bodyEnd = sixelStr.lastIndexOf('\x1b\\');
        if (bodyEnd === -1) bodyEnd = sixelStr.lastIndexOf('\x9c');
        if (bodyEnd === -1) bodyEnd = sixelStr.length;

        var body = sixelStr.substring(bodyStart, bodyEnd);

        // 如果没有光栅属性，预扫描宽度（考虑 RLE）
        if (width === 0) {
            var tx = 0, mx = 0;
            var si = 0;
            while (si < body.length) {
                var c = body.charCodeAt(si);
                if (c === 0x24 || c === 0x2D) {
                    mx = Math.max(mx, tx); tx = 0; si++;
                } else if (c === 0x23) {
                    si++;
                    while (si < body.length && body.charCodeAt(si) !== 0x3B &&
                           !(body.charCodeAt(si) >= 0x30 && body.charCodeAt(si) <= 0x39)) si++;
                } else if (c === 0x21) {
                    // RLE: !count char
                    si++;
                    var countStr = '';
                    while (si < body.length && body.charCodeAt(si) >= 0x30 && body.charCodeAt(si) <= 0x39) {
                        countStr += body[si]; si++;
                    }
                    var rleCount = parseInt(countStr) || 1;
                    tx += rleCount;
                    si++; // skip the sixel char
                } else if (c >= 0x3F && c <= 0x7E) {
                    tx++; si++;
                } else {
                    si++;
                }
            }
            width = Math.max(mx, tx) || 80;
        }

        // 解析
        var currentColor = 0;
        var x = 0, currentBandY = 0;
        var bandMap = new Map();

        function ensureBand(color, bandY) {
            var key = color * 100000 + bandY;
            if (!bandMap.has(key)) {
                var d = new Uint8Array(width);
                bandMap.set(key, d);
            }
            return bandMap.get(key);
        }

        var i = 0;
        while (i < body.length) {
            var ch = body.charCodeAt(i);

            // '#' 颜色标记或颜色定义
            if (ch === 0x23) {
                i++;
                var numStr = '';
                while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) {
                    numStr += body[i]; i++;
                }
                var colorNum = parseInt(numStr) || 0;

                // 检查是否有颜色定义 #N;2;R;G;B
                if (i < body.length && body.charCodeAt(i) === 0x3B) {
                    // 这是颜色定义
                    i++; // skip ';'
                    var typeStr = '';
                    while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) {
                        typeStr += body[i]; i++;
                    }
                    if (typeStr === '2' && i < body.length && body.charCodeAt(i) === 0x3B) {
                        i++; // skip ';'
                        var rStr = '';
                        while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) { rStr += body[i]; i++; }
                        if (i < body.length && body.charCodeAt(i) === 0x3B) { i++; }
                        var gStr = '';
                        while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) { gStr += body[i]; i++; }
                        if (i < body.length && body.charCodeAt(i) === 0x3B) { i++; }
                        var bStr = '';
                        while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) { bStr += body[i]; i++; }
                        palette[colorNum] = [
                            Math.round(parseInt(rStr) * 255 / 100),
                            Math.round(parseInt(gStr) * 255 / 100),
                            Math.round(parseInt(bStr) * 255 / 100)
                        ];
                    }
                    // 不回退 i，继续解析下一个字符
                } else {
                    // 这是颜色选择 #N
                    currentColor = colorNum;
                    // 不回退 i，继续解析下一个字符
                }
                continue;
            }

            // '$' 回到行首
            if (ch === 0x24) { x = 0; i++; continue; }

            // '-' 换行
            if (ch === 0x2D) { x = 0; currentBandY += 6; i++; continue; }

            // RLE: !count char
            if (ch === 0x21) {
                i++;
                var rCountStr = '';
                while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) {
                    rCountStr += body[i]; i++;
                }
                var rCount = parseInt(rCountStr) || 1;
                if (i < body.length) {
                    var rBits = body.charCodeAt(i) - 0x3F;
                    var rArr = ensureBand(currentColor, currentBandY);
                    for (var rc = 0; rc < rCount && x < width; rc++) {
                        rArr[x] = rBits;
                        x++;
                    }
                }
                i++; continue;
            }

            // Sixel 字符 (0x3F - 0x7E)
            if (ch >= 0x3F && ch <= 0x7E) {
                var sBits = ch - 0x3F;
                var sArr = ensureBand(currentColor, currentBandY);
                if (x < width) {
                    sArr[x] = sBits;
                    x++;
                }
                i++; continue;
            }

            i++;
        }

        // 计算高度
        var maxBandY = 0;
        for (var entry of bandMap) {
            var bandY = entry[0] % 100000;
            if (bandY + 6 > maxBandY) maxBandY = bandY + 6;
        }
        if (height === 0) height = maxBandY || 6;

        // 渲染 RGBA
        var pixels = new Uint8ClampedArray(width * height * 4);

        for (var entry of bandMap) {
            var key = entry[0];
            var arr = entry[1];
            var color = (key / 100000) | 0;
            var bY = key % 100000;
            var cr = palette[color][0], cg = palette[color][1], cb = palette[color][2];

            for (var xx = 0; xx < width; xx++) {
                var bits = arr[xx];
                for (var bit = 0; bit < 6; bit++) {
                    if (bits & (1 << bit)) {
                        var py = bY + bit;
                        if (py < height) {
                            var idx = (py * width + xx) * 4;
                            pixels[idx] = cr;
                            pixels[idx + 1] = cg;
                            pixels[idx + 2] = cb;
                            pixels[idx + 3] = 255;
                        }
                    }
                }
            }
        }

        return { width: width, height: height, pixels: pixels };
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
