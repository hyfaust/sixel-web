/**
 * quantize.js — 颜色量化 (改进 Median Cut)
 *
 * 改进:
 * - 选择分割 box 时使用 像素加权范围 (而非仅颜色数量)
 * - 分割点使用加权中位数 (按像素数量平衡)
 * - 精确匹配失败时使用最近邻颜色
 */
(function () {
    'use strict';

    function medianCut(rgba, w, h, maxColors) {
        // 构建颜色直方图 (只计算不透明像素)
        var histogram = new Map();
        var totalCount = 0;
        for (var i = 0; i < w * h; i++) {
            var a = rgba[i * 4 + 3];
            if (a < 128) continue;
            var key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
            var prev = histogram.get(key);
            if (prev !== undefined) {
                histogram.set(key, prev + 1);
            } else {
                histogram.set(key, 1);
            }
            totalCount++;
        }

        // 直方图颜色数不超过 maxColors 时直接映射
        if (histogram.size <= maxColors) {
            var palette = new Uint8Array(maxColors * 3);
            var colorMap = new Map();
            var idx = 0;
            for (var entry of histogram) {
                var ekey = entry[0];
                palette[idx * 3] = (ekey >> 16) & 0xFF;
                palette[idx * 3 + 1] = (ekey >> 8) & 0xFF;
                palette[idx * 3 + 2] = ekey & 0xFF;
                colorMap.set(ekey, idx);
                idx++;
            }
            var pixels = new Uint8Array(w * h);
            for (var i = 0; i < w * h; i++) {
                var pxKey = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
                pixels[i] = colorMap.get(pxKey) || 0;
            }
            return { pixels: pixels, palette: palette };
        }

        // Median Cut
        var boxes = [{ colors: [] }];
        for (var entry of histogram) {
            var hkey = entry[0];
            boxes[0].colors.push({
                r: (hkey >> 16) & 0xFF, g: (hkey >> 8) & 0xFF, b: hkey & 0xFF,
                count: entry[1]
            });
        }

        while (boxes.length < maxColors) {
            // 选择 像素数量×颜色范围 最大的 box 分割
            var maxIdx = 0, maxScore = 0;
            for (var bi = 0; bi < boxes.length; bi++) {
                var boxColors = boxes[bi].colors;
                var bminR = 255, bmaxR = 0, bminG = 255, bmaxG = 0, bminB = 255, bmaxB = 0, bPixels = 0;
                for (var ci = 0; ci < boxColors.length; ci++) {
                    var bc = boxColors[ci];
                    if (bc.r < bminR) bminR = bc.r; if (bc.r > bmaxR) bmaxR = bc.r;
                    if (bc.g < bminG) bminG = bc.g; if (bc.g > bmaxG) bmaxG = bc.g;
                    if (bc.b < bminB) bminB = bc.b; if (bc.b > bmaxB) bmaxB = bc.b;
                    bPixels += bc.count;
                }
                var range = Math.max(bmaxR - bminR, bmaxG - bminG, bmaxB - bminB);
                var score = bPixels * range;
                if (score > maxScore) {
                    maxScore = score;
                    maxIdx = bi;
                }
            }

            if (boxes[maxIdx].colors.length < 2) break;

            var box = boxes.splice(maxIdx, 1)[0];
            var split = splitBox(box.colors);
            boxes.push({ colors: split[0] });
            boxes.push({ colors: split[1] });
        }

        // 计算每个 box 的代表色和颜色映射
        var palette = new Uint8Array(Math.max(maxColors, boxes.length) * 3);
        var paletteLookup = new Map();

        for (var i = 0; i < boxes.length; i++) {
            var bColors = boxes[i].colors;
            var tr = 0, tg = 0, tb = 0, tc = 0;
            for (var j = 0; j < bColors.length; j++) {
                tr += bColors[j].r * bColors[j].count;
                tg += bColors[j].g * bColors[j].count;
                tb += bColors[j].b * bColors[j].count;
                tc += bColors[j].count;
            }
            var r = Math.round(tr / tc);
            var g = Math.round(tg / tc);
            var b = Math.round(tb / tc);
            palette[i * 3] = r;
            palette[i * 3 + 1] = g;
            palette[i * 3 + 2] = b;

            for (var j = 0; j < bColors.length; j++) {
                var ckey = (bColors[j].r << 16) | (bColors[j].g << 8) | bColors[j].b;
                paletteLookup.set(ckey, i);
            }
        }

        // 预计算调色板 RGB 数组（用于最近邻查找）
        var palCount = boxes.length;
        var palR = new Uint8Array(palCount);
        var palG = new Uint8Array(palCount);
        var palB = new Uint8Array(palCount);
        for (var i = 0; i < palCount; i++) {
            palR[i] = palette[i * 3];
            palG[i] = palette[i * 3 + 1];
            palB[i] = palette[i * 3 + 2];
        }

        // 映射所有像素
        var pixels = new Uint8Array(w * h);
        for (var i = 0; i < w * h; i++) {
            var pr = rgba[i * 4], pg = rgba[i * 4 + 1], pb = rgba[i * 4 + 2];
            var pxKey = (pr << 16) | (pg << 8) | pb;
            var found = paletteLookup.get(pxKey);
            if (found !== undefined) {
                pixels[i] = found;
            } else {
                // 最近邻查找
                var bestIdx = 0, bestDist = 0x7FFFFFFF;
                for (var pi = 0; pi < palCount; pi++) {
                    var dr = pr - palR[pi], dg = pg - palG[pi], db = pb - palB[pi];
                    var dist = dr * dr + dg * dg + db * db;
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = pi;
                        if (dist === 0) break;
                    }
                }
                pixels[i] = bestIdx;
            }
        }

        return { pixels: pixels, palette: palette };
    }

    /**
     * 分割一个颜色 box 为两个子 box
     * 使用加权中位数（按像素数量平衡分割）
     */
    function splitBox(colors) {
        var minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        for (var i = 0; i < colors.length; i++) {
            var c = colors[i];
            if (c.r < minR) minR = c.r; if (c.r > maxR) maxR = c.r;
            if (c.g < minG) minG = c.g; if (c.g > maxG) maxG = c.g;
            if (c.b < minB) minB = c.b; if (c.b > maxB) maxB = c.b;
        }

        var rangeR = maxR - minR, rangeG = maxG - minG, rangeB = maxB - minB;
        var ch;
        if (rangeR >= rangeG && rangeR >= rangeB) ch = 'r';
        else if (rangeG >= rangeR && rangeG >= rangeB) ch = 'g';
        else ch = 'b';

        colors.sort(function (a, b) { return a[ch] - b[ch]; });

        // 加权中位数：按像素数量划分，使两边总像素数尽量相等
        var totalPixels = 0;
        for (var i = 0; i < colors.length; i++) totalPixels += colors[i].count;
        var half = totalPixels / 2;
        var accumulated = 0;
        var splitIdx = colors.length >> 1;
        for (var i = 0; i < colors.length; i++) {
            accumulated += colors[i].count;
            if (accumulated >= half) {
                splitIdx = i + 1;
                break;
            }
        }
        if (splitIdx < 1) splitIdx = 1;
        if (splitIdx >= colors.length) splitIdx = colors.length - 1;

        return [colors.slice(0, splitIdx), colors.slice(splitIdx)];
    }

    window.Quantize = { medianCut: medianCut };
})();
