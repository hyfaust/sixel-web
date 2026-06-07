/**
 * quantize.js — 颜色量化
 *
 * 提供两种算法:
 * - medianCut: 改进的 Median Cut (像素加权范围选择 + 加权中位数分割)
 * - pnnQuant: PNN (Pairwise Nearest Neighbor) 高质量量化 (chafa 使用)
 *
 * 改进:
 * - 选择分割 box 时使用 像素加权范围 (而非仅颜色数量)
 * - 分割点使用加权中位数 (按像素数量平衡)
 * - 精确匹配失败时使用最近邻颜色
 * - PNN 算法可选，质量更高
 */
(function () {
    'use strict';

    // ============================================================
    // PNN (Pairwise Nearest Neighbor) 量化
    // ============================================================

    function pnnQuant(rgba, w, h, maxColors) {
        // 构建直方图
        var histogram = new Map();
        for (var i = 0; i < w * h; i++) {
            if (rgba[i * 4 + 3] < 128) continue;
            var key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
            var prev = histogram.get(key);
            histogram.set(key, prev !== undefined ? prev + 1 : 1);
        }

        if (histogram.size <= maxColors) {
            return buildDirectMapping(rgba, w, h, histogram, maxColors);
        }

        // 初始化 bins（预量化到 5-bit 以减少初始 bin 数量，最大 32768 bins）
        var bins = [];
        var quantMap = new Map();
        for (var entry of histogram) {
            var key = entry[0];
            var cnt = entry[1];
            var r = (key >> 16) & 0xFF;
            var g = (key >> 8) & 0xFF;
            var b = key & 0xFF;
            // 5-bit 量化（精度损失由 centroid 平均补偿）
            var qKey = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            var existing = quantMap.get(qKey);
            if (existing !== undefined) {
                var bin = bins[existing];
                bin.cnt += cnt;
                bin.sr += r * cnt;
                bin.sg += g * cnt;
                bin.sb += b * cnt;
            } else {
                quantMap.set(qKey, bins.length);
                bins.push({
                    cnt: cnt,
                    sr: r * cnt, sg: g * cnt, sb: b * cnt,
                    nn: -1, dist: 1e100
                });
            }
        }
        quantMap = null;

        var nBins = bins.length;

        if (nBins > maxColors) {
            // 阶段 1: 找每个 bin 的最近邻
            for (var i = 0; i < nBins; i++) {
                var bi = bins[i];
                bi.dist = 1e100;
                for (var j = i + 1; j < nBins; j++) {
                    var bj = bins[j];
                    var dn = bi.cnt * bj.cnt;
                    var dr = bi.sr / bi.cnt - bj.sr / bj.cnt;
                    var dg = bi.sg / bi.cnt - bj.sg / bj.cnt;
                    var db = bi.sb / bi.cnt - bj.sb / bj.cnt;
                    var d = dn * (dr * dr + dg * dg + db * db);
                    if (d < bi.dist) { bi.dist = d; bi.nn = j; }
                    if (d < bj.dist) { bj.dist = d; bj.nn = i; }
                }
            }

            // 阶段 2: 迭代合并
            while (nBins > maxColors) {
                var bestI = -1, bestDist = 1e100;
                for (var i = 0; i < bins.length; i++) {
                    if (bins[i] && bins[i].dist < bestDist) {
                        bestDist = bins[i].dist;
                        bestI = i;
                    }
                }

                var binI = bins[bestI];
                var bestJ = binI.nn;
                // 如果 nn 指向已删除的 bin，重新计算最近邻
                if (!bins[bestJ]) {
                    binI.dist = 1e100; binI.nn = -1;
                    for (var j = 0; j < bins.length; j++) {
                        if (!bins[j] || j === bestI) continue;
                        var bj2 = bins[j];
                        var dn2 = binI.cnt * bj2.cnt;
                        var dr2 = binI.sr / binI.cnt - bj2.sr / bj2.cnt;
                        var dg2 = binI.sg / binI.cnt - bj2.sg / bj2.cnt;
                        var db2 = binI.sb / binI.cnt - bj2.sb / bj2.cnt;
                        var d2 = dn2 * (dr2 * dr2 + dg2 * dg2 + db2 * db2);
                        if (d2 < binI.dist) { binI.dist = d2; binI.nn = j; }
                    }
                    bestJ = binI.nn;
                    if (bestJ < 0) continue; // 无有效合并目标，跳过
                }
                var binJ = bins[bestJ];

                binJ.cnt += binI.cnt;
                binJ.sr += binI.sr;
                binJ.sg += binI.sg;
                binJ.sb += binI.sb;
                bins[bestI] = null;
                nBins--;

                // 更新 binJ 的最近邻，并修复所有指向 binI 的 nn
                binJ.dist = 1e100;
                binJ.nn = -1;
                for (var j = 0; j < bins.length; j++) {
                    if (!bins[j] || j === bestJ) continue;
                    var bj = bins[j];
                    // 修复：如果这个 bin 的 nn 指向已删除的 binI，指向 binJ
                    if (bj.nn === bestI) { bj.nn = bestJ; }
                    var dn = binJ.cnt * bj.cnt;
                    var dr = binJ.sr / binJ.cnt - bj.sr / bj.cnt;
                    var dg = binJ.sg / binJ.cnt - bj.sg / bj.cnt;
                    var db = binJ.sb / binJ.cnt - bj.sb / bj.cnt;
                    var d = dn * (dr * dr + dg * dg + db * db);
                    if (d < binJ.dist) { binJ.dist = d; binJ.nn = j; }
                    if (d < bj.dist) { bj.dist = d; bj.nn = bestJ; }
                }
            }
        }

        // 构建调色板
        var palette = new Uint8Array(maxColors * 3);
        var palR = new Uint8Array(maxColors);
        var palG = new Uint8Array(maxColors);
        var palB = new Uint8Array(maxColors);
        var palIdx = 0;
        for (var i = 0; i < bins.length; i++) {
            if (!bins[i]) continue;
            var b = bins[i];
            var r = Math.round(b.sr / b.cnt);
            var g = Math.round(b.sg / b.cnt);
            var bl = Math.round(b.sb / b.cnt);
            palette[palIdx * 3] = r;
            palette[palIdx * 3 + 1] = g;
            palette[palIdx * 3 + 2] = bl;
            palR[palIdx] = r;
            palG[palIdx] = g;
            palB[palIdx] = bl;
            b.palIdx = palIdx;
            palIdx++;
        }
        var palCount = palIdx;

        // 构建从原始颜色到调色板的映射（最近邻匹配）
        var origColorMap = new Map();
        for (var entry of histogram) {
            var key = entry[0];
            var pr = (key >> 16) & 0xFF;
            var pg = (key >> 8) & 0xFF;
            var pb = key & 0xFF;
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
            origColorMap.set(key, bestIdx);
        }

        var pixels = new Uint8Array(w * h);
        for (var i = 0; i < w * h; i++) {
            var key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
            pixels[i] = origColorMap.get(key) || 0;
        }

        return { pixels: pixels, palette: palette };
    }

    // ============================================================
    // Median Cut 量化 (改进版)
    // ============================================================

    function medianCut(rgba, w, h, maxColors) {
        // 构建颜色直方图 (只计算不透明像素)
        var histogram = new Map();
        for (var i = 0; i < w * h; i++) {
            var a = rgba[i * 4 + 3];
            if (a < 128) continue;
            var key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
            var prev = histogram.get(key);
            histogram.set(key, prev !== undefined ? prev + 1 : 1);
        }

        // 直方图颜色数不超过 maxColors 时直接映射
        if (histogram.size <= maxColors) {
            return buildDirectMapping(rgba, w, h, histogram, maxColors);
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

        // 计算每个 box 的代表色
        var palette = new Uint8Array(Math.max(maxColors, boxes.length) * 3);
        var paletteLookup = new Map();
        var palCount = boxes.length;
        var palR = new Uint8Array(palCount);
        var palG = new Uint8Array(palCount);
        var palB = new Uint8Array(palCount);

        for (var i = 0; i < palCount; i++) {
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
            palR[i] = r;
            palG[i] = g;
            palB[i] = b;

            for (var j = 0; j < bColors.length; j++) {
                var ckey = (bColors[j].r << 16) | (bColors[j].g << 8) | bColors[j].b;
                paletteLookup.set(ckey, i);
            }
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

    // ============================================================
    // 共用辅助函数
    // ============================================================

    /** 当颜色数不超过 maxColors 时直接映射 */
    function buildDirectMapping(rgba, w, h, histogram, maxColors) {
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

    /** 分割一个颜色 box 为两个子 box（加权中位数） */
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

        var totalPixels = 0;
        for (var i = 0; i < colors.length; i++) totalPixels += colors[i].count;
        var half = totalPixels / 2;
        var accumulated = 0;
        var splitIdx = colors.length >> 1;
        for (var i = 0; i < colors.length; i++) {
            accumulated += colors[i].count;
            if (accumulated >= half) { splitIdx = i + 1; break; }
        }
        if (splitIdx < 1) splitIdx = 1;
        if (splitIdx >= colors.length) splitIdx = colors.length - 1;

        return [colors.slice(0, splitIdx), colors.slice(splitIdx)];
    }

    // ============================================================
    // 公开 API
    // ============================================================

    window.Quantize = {
        medianCut: medianCut,
        pnnQuant: pnnQuant
    };
})();
