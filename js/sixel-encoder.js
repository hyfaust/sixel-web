/**
 * sixel-encoder.js — Sixel 编码器 (从 pysixel.py 移植)
 */

(function () {
    'use strict';

    const SIXEL_WEIGHTS = new Uint8Array([1, 2, 4, 8, 16, 32]);
    const COLOR_STR = Array.from({ length: 256 }, (_, i) => `#${i}`);
    const te = new TextEncoder();

    /**
     * 将调色板索引像素数组编码为 Sixel 字节
     */
    function encodeSixel(pixels, palette, w, h, opts) {
        opts = opts || {};
        const eightBit = opts.eightBit || false;
        const griLimit = opts.griLimit || false;
        const encodePolicy = opts.encodePolicy || 'auto';

        // 收集使用的颜色
        const usedColorSet = new Set();
        for (let i = 0; i < pixels.length; i++) usedColorSet.add(pixels[i]);
        const usedColors = Array.from(usedColorSet).sort((a, b) => a - b);

        const parts = [];
        let totalLen = 0;

        function push(bytes) {
            parts.push(bytes);
            totalLen += bytes.length;
        }

        // DCS 头
        push(te.encode(eightBit ? '\x900;0;0q' : '\x1bP0;0;0q'));

        // 颜色定义
        for (let k = 0; k < usedColors.length; k++) {
            const idx = usedColors[k];
            const r = palette[idx * 3];
            const g = palette[idx * 3 + 1];
            const b = palette[idx * 3 + 2];
            push(te.encode(
                '#' + idx + ';2;' + ((r * 100 / 255) | 0) + ';' + ((g * 100 / 255) | 0) + ';' + ((b * 100 / 255) | 0)
            ));
        }

        // 逐 band 编码
        for (let sy = 0; sy < h; sy += 6) {
            const bandH = Math.min(6, h - sy);

            // 收集 band 中的颜色
            const bandColorSet = new Set();
            for (let y = 0; y < bandH; y++) {
                for (let x = 0; x < w; x++) {
                    bandColorSet.add(pixels[(sy + y) * w + x]);
                }
            }
            const bandColors = Array.from(bandColorSet).sort((a, b) => a - b);

            for (let ci = 0; ci < bandColors.length; ci++) {
                const cidx = bandColors[ci];

                // 颜色标记
                push(te.encode(COLOR_STR[cidx]));

                // 计算每列的 sixel 值
                const sixelVals = new Uint8Array(w);
                for (let x = 0; x < w; x++) {
                    let bits = 0;
                    for (let bit = 0; bit < bandH; bit++) {
                        if (pixels[(sy + bit) * w + x] === cidx) {
                            bits |= SIXEL_WEIGHTS[bit];
                        }
                    }
                    sixelVals[x] = 0x3F + bits;
                }

                // RLE 编码
                push(rleEncode(sixelVals, griLimit, encodePolicy));

                // '$' 回到行首
                push(new Uint8Array([0x24]));
            }

            // 最后一个 '$' 改为 '-'
            const last = parts[parts.length - 1];
            if (last.length === 1 && last[0] === 0x24) {
                parts[parts.length - 1] = new Uint8Array([0x2D]);
            } else {
                push(new Uint8Array([0x2D]));
            }
        }

        // DCS 尾
        push(te.encode(eightBit ? '\x9c' : '\x1b\\'));

        // 合并
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (let i = 0; i < parts.length; i++) {
            result.set(parts[i], offset);
            offset += parts[i].length;
        }
        return result;
    }

    function rleEncode(vals, griLimit, encodePolicy) {
        const n = vals.length;
        if (n === 0) return new Uint8Array(0);
        if (encodePolicy === 'fast') return vals.slice();

        const threshold = encodePolicy === 'size' ? 2 : 4;
        const out = [];

        let i = 0;
        while (i < n) {
            const v = vals[i];
            let j = i + 1;
            while (j < n && vals[j] === v) j++;
            const run = j - i;

            if (run >= threshold) {
                if (griLimit) {
                    let rem = run;
                    while (rem > 0) {
                        const chunk = Math.min(rem, 255);
                        out.push(0x21);
                        const s = String(chunk);
                        for (let k = 0; k < s.length; k++) out.push(s.charCodeAt(k));
                        out.push(v);
                        rem -= chunk;
                    }
                } else {
                    out.push(0x21);
                    const s = String(run);
                    for (let k = 0; k < s.length; k++) out.push(s.charCodeAt(k));
                    out.push(v);
                }
            } else {
                for (let k = i; k < j; k++) out.push(vals[k]);
            }
            i = j;
        }
        return new Uint8Array(out);
    }

    window.SixelEncoder = { encodeSixel: encodeSixel };
})();
