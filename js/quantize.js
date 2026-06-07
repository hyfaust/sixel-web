/**
 * quantize.js — 颜色量化 (简化 Median Cut)
 */
(function () {
    'use strict';

    function medianCut(rgba, w, h, maxColors) {
        // 构建颜色直方图
        const histogram = new Map();
        for (let i = 0; i < w * h; i++) {
            const a = rgba[i * 4 + 3];
            if (a < 128) continue;
            const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
            histogram.set(key, (histogram.get(key) || 0) + 1);
        }

        if (histogram.size <= maxColors) {
            const palette = new Uint8Array(maxColors * 3);
            const colorMap = new Map();
            let idx = 0;
            for (const entry of histogram) {
                const key = entry[0];
                palette[idx * 3] = (key >> 16) & 0xFF;
                palette[idx * 3 + 1] = (key >> 8) & 0xFF;
                palette[idx * 3 + 2] = key & 0xFF;
                colorMap.set(key, idx);
                idx++;
            }
            const pixels = new Uint8Array(w * h);
            for (let i = 0; i < w * h; i++) {
                const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
                pixels[i] = colorMap.get(key) || 0;
            }
            return { pixels: pixels, palette: palette };
        }

        // Median Cut
        let boxes = [{ colors: [] }];
        for (const entry of histogram) {
            const key = entry[0];
            boxes[0].colors.push({
                r: (key >> 16) & 0xFF, g: (key >> 8) & 0xFF, b: key & 0xFF,
                count: entry[1]
            });
        }

        while (boxes.length < maxColors) {
            let maxIdx = 0, maxSize = 0;
            for (let i = 0; i < boxes.length; i++) {
                if (boxes[i].colors.length > maxSize) {
                    maxSize = boxes[i].colors.length;
                    maxIdx = i;
                }
            }
            if (maxSize < 2) break;

            const box = boxes.splice(maxIdx, 1)[0];
            const split = splitBox(box.colors);
            boxes.push({ colors: split[0] });
            boxes.push({ colors: split[1] });
        }

        // 代表色
        const palette = new Uint8Array(Math.max(maxColors, boxes.length) * 3);
        const paletteLookup = new Map();

        for (let i = 0; i < boxes.length; i++) {
            const colors = boxes[i].colors;
            let tr = 0, tg = 0, tb = 0, tc = 0;
            for (let j = 0; j < colors.length; j++) {
                tr += colors[j].r * colors[j].count;
                tg += colors[j].g * colors[j].count;
                tb += colors[j].b * colors[j].count;
                tc += colors[j].count;
            }
            const r = Math.round(tr / tc);
            const g = Math.round(tg / tc);
            const b = Math.round(tb / tc);
            palette[i * 3] = r;
            palette[i * 3 + 1] = g;
            palette[i * 3 + 2] = b;

            for (let j = 0; j < colors.length; j++) {
                const key = (colors[j].r << 16) | (colors[j].g << 8) | colors[j].b;
                paletteLookup.set(key, i);
            }
        }

        const pixels = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
            pixels[i] = paletteLookup.get(key) || 0;
        }

        return { pixels: pixels, palette: palette };
    }

    function splitBox(colors) {
        let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        for (let i = 0; i < colors.length; i++) {
            const c = colors[i];
            if (c.r < minR) minR = c.r; if (c.r > maxR) maxR = c.r;
            if (c.g < minG) minG = c.g; if (c.g > maxG) maxG = c.g;
            if (c.b < minB) minB = c.b; if (c.b > maxB) maxB = c.b;
        }

        const rangeR = maxR - minR, rangeG = maxG - minG, rangeB = maxB - minB;
        let ch;
        if (rangeR >= rangeG && rangeR >= rangeB) ch = 'r';
        else if (rangeG >= rangeR && rangeG >= rangeB) ch = 'g';
        else ch = 'b';

        colors.sort(function (a, b) { return a[ch] - b[ch]; });

        let totalCount = 0;
        for (let i = 0; i < colors.length; i++) totalCount += colors[i].count;
        let half = 0;
        let splitIdx = colors.length >> 1;
        for (let i = 0; i < colors.length; i++) {
            half += colors[i].count;
            if (half >= totalCount / 2) { splitIdx = i + 1; break; }
        }

        return [colors.slice(0, splitIdx), colors.slice(splitIdx)];
    }

    window.Quantize = { medianCut: medianCut };
})();
