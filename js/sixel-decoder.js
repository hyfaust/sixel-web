/**
 * sixel-decoder.js — Sixel 解码器
 */
(function () {
    'use strict';

    /**
     * 解码 Sixel 文本为 RGBA 像素
     */
    function decodeSixel(sixelStr) {
        const palette = [];
        for (let i = 0; i < 256; i++) palette.push([0, 0, 0]);

        let width = 0, height = 0;

        // 光栅属性
        const rasterMatch = sixelStr.match(/"(\d+);(\d+);(\d+);(\d+)/);
        if (rasterMatch) {
            width = parseInt(rasterMatch[3]);
            height = parseInt(rasterMatch[4]);
        }

        // 提取 body
        let bodyStart = sixelStr.indexOf('q');
        if (bodyStart === -1) return { width: 0, height: 0, pixels: new Uint8ClampedArray(0) };
        bodyStart++;

        let bodyEnd = sixelStr.lastIndexOf('\x1b\\');
        if (bodyEnd === -1) bodyEnd = sixelStr.lastIndexOf('\x9c');
        if (bodyEnd === -1) bodyEnd = sixelStr.length;

        const body = sixelStr.substring(bodyStart, bodyEnd);

        // 预扫描宽度
        if (width === 0) {
            let tx = 0, mx = 0;
            for (let i = 0; i < body.length; i++) {
                const c = body.charCodeAt(i);
                if (c === 0x24 || c === 0x2D) { mx = Math.max(mx, tx); tx = 0; }
                else if (c >= 0x3F && c <= 0x7E) tx++;
            }
            width = Math.max(mx, tx) || 80;
        }

        // 解析
        let currentColor = 0;
        let x = 0, currentBandY = 0;
        const bandMap = new Map();

        function ensureBand(color, bandY) {
            const key = color * 10000 + bandY;
            if (!bandMap.has(key)) {
                const d = new Uint8Array(width);
                d.fill(0x3F);
                bandMap.set(key, d);
            }
            return bandMap.get(key);
        }

        let i = 0;
        while (i < body.length) {
            const ch = body.charCodeAt(i);

            if (ch === 0x23) { // '#'
                i++;
                let numStr = '';
                while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) {
                    numStr += body[i]; i++;
                }
                const colorNum = parseInt(numStr) || 0;

                if (i < body.length && body.charCodeAt(i) === 0x3B) {
                    i++;
                    let typeStr = '';
                    while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) {
                        typeStr += body[i]; i++;
                    }
                    if (typeStr === '2') {
                        i++;
                        let rStr = '';
                        while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) { rStr += body[i]; i++; }
                        i++;
                        let gStr = '';
                        while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) { gStr += body[i]; i++; }
                        i++;
                        let bStr = '';
                        while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) { bStr += body[i]; i++; }
                        palette[colorNum] = [
                            Math.round(parseInt(rStr) * 255 / 100),
                            Math.round(parseInt(gStr) * 255 / 100),
                            Math.round(parseInt(bStr) * 255 / 100)
                        ];
                        i--;
                    }
                } else {
                    currentColor = colorNum;
                    i--;
                }
                i++; continue;
            }

            if (ch === 0x24) { x = 0; i++; continue; }
            if (ch === 0x2D) { x = 0; currentBandY += 6; i++; continue; }

            if (ch === 0x21) { // '!'
                i++;
                let countStr = '';
                while (i < body.length && body.charCodeAt(i) >= 0x30 && body.charCodeAt(i) <= 0x39) {
                    countStr += body[i]; i++;
                }
                const count = parseInt(countStr) || 1;
                if (i < body.length) {
                    const bits = body.charCodeAt(i) - 0x3F;
                    const arr = ensureBand(currentColor, currentBandY);
                    for (let c = 0; c < count && x < width; c++) { arr[x] = bits; x++; }
                }
                i++; continue;
            }

            if (ch >= 0x3F && ch <= 0x7E) {
                const bits = ch - 0x3F;
                const arr = ensureBand(currentColor, currentBandY);
                if (x < width) { arr[x] |= bits; x++; }
                i++; continue;
            }

            i++;
        }

        // 计算高度
        let maxBandY = 0;
        for (const key of bandMap.keys()) {
            const bandY = key % 10000;
            if (bandY + 6 > maxBandY) maxBandY = bandY + 6;
        }
        if (height === 0) height = maxBandY || 6;

        // 渲染 RGBA
        const pixels = new Uint8ClampedArray(width * height * 4);

        for (const entry of bandMap) {
            const key = entry[0];
            const arr = entry[1];
            const color = (key / 10000) | 0;
            const bandY = key % 10000;
            const r = palette[color][0], g = palette[color][1], b = palette[color][2];

            for (let xx = 0; xx < width; xx++) {
                const bits = arr[xx];
                for (let bit = 0; bit < 6; bit++) {
                    if (bits & (1 << bit)) {
                        const py = bandY + bit;
                        if (py < height) {
                            const idx = (py * width + xx) * 4;
                            pixels[idx] = r;
                            pixels[idx + 1] = g;
                            pixels[idx + 2] = b;
                            pixels[idx + 3] = 255;
                        }
                    }
                }
            }
        }

        return { width: width, height: height, pixels: pixels };
    }

    function renderSixelToCanvas(sixelStr, canvas) {
        const result = decodeSixel(sixelStr);
        canvas.width = result.width;
        canvas.height = result.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
        return { width: result.width, height: result.height };
    }

    window.SixelDecoder = { decodeSixel: decodeSixel, renderSixelToCanvas: renderSixelToCanvas };
})();
