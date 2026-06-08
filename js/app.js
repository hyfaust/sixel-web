/**
 * app.js — sixel-web 主应用逻辑
 */
(function () {
    'use strict';

    // ============================================================
    // 图像预处理
    // ============================================================

    function preprocessImage(imageData, w, h, opts) {
        var maxColors = opts.maxColors || 256;
        var maxPxWidth = opts.maxPxWidth || 0;
        var ditherMode = opts.dither || 'none'; // 'none' | 'bayer' | 'fs'

        // 缩放
        var targetW = w, targetH = h;
        if (maxPxWidth > 0 && w > maxPxWidth) {
            var ratio = maxPxWidth / w;
            targetW = maxPxWidth;
            targetH = Math.round(h * ratio);
        }
        if (targetH < 1) targetH = 1;
        if (targetW < 1) targetW = 1;

        // Canvas 缩放
        var canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        var srcCanvas = document.createElement('canvas');
        srcCanvas.width = w;
        srcCanvas.height = h;
        srcCanvas.getContext('2d').putImageData(imageData, 0, 0);

        ctx.drawImage(srcCanvas, 0, 0, targetW, targetH);
        var resizedData = ctx.getImageData(0, 0, targetW, targetH);

        // Bayer 预抖动（量化前）
        var quantInput = resizedData;
        if (ditherMode === 'bayer') {
            quantInput = applyBayerDither(resizedData, targetW, targetH, maxColors);
        }

        // 量化（返回 { pixels, palette, histEntries }）
        var result;
        if (opts.quality === 'high') {
            result = window.Quantize.pnnQuant(quantInput.data, targetW, targetH, maxColors);
        } else {
            result = window.Quantize.medianCut(quantInput.data, targetW, targetH, maxColors);
        }

        // Floyd-Steinberg 后处理误差扩散
        // 量化前唯一色数 ≤ maxColors 时，量化无损，跳过 FS
        if (ditherMode === 'fs' && result.histEntries > maxColors) {
            result.pixels = applyFloydSteinberg(
                quantInput.data, result.pixels, result.palette, targetW, targetH);
        }

        return { pixels: result.pixels, palette: result.palette, w: targetW, h: targetH };
    }

    function applyBayerDither(imageData, w, h, maxColors) {
        var BAYER8 = [
            [0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],
            [12,44,4,36,14,46,6,38],[60,28,52,20,62,30,54,22],
            [3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],
            [15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21]
        ];
        var amplitude = 255.0 / maxColors;
        var data = new Uint8ClampedArray(imageData.data);
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var offset = (y * w + x) * 4;
                var bayer = (BAYER8[y % 8][x % 8] / 64.0 - 0.5) * amplitude;
                data[offset] = Math.max(0, Math.min(255, data[offset] + bayer));
                data[offset+1] = Math.max(0, Math.min(255, data[offset+1] + bayer));
                data[offset+2] = Math.max(0, Math.min(255, data[offset+2] + bayer));
            }
        }
        return new ImageData(data, w, h);
    }

    /**
     * Floyd-Steinberg 误差扩散（与 libsixel diffuse_fs 一致）
     *
     * 对量化后的像素进行误差扩散：对每个像素找到最近调色板色，
     * 计算量化误差，按 FS 权重传播到相邻像素。
     *
     *          curr    7/16
     *  3/16    5/16    1/16
     */
    function applyFloydSteinberg(rgba, pixels, palette, w, h) {
        var palCount = palette.length / 3;
        // 工作缓冲区（float32，每通道独立）
        var errR = new Float32Array(w * h);
        var errG = new Float32Array(w * h);
        var errB = new Float32Array(w * h);
        // 初始化为原始像素值
        for (var i = 0; i < w * h; i++) {
            errR[i] = rgba[i * 4];
            errG[i] = rgba[i * 4 + 1];
            errB[i] = rgba[i * 4 + 2];
        }

        var out = new Uint8Array(w * h);
        // 15-bit 颜色查找缓存（libsixel cachetable 策略）
        var cache = new Uint16Array(32768);

        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var pos = y * w + x;
                var r = errR[pos], g = errG[pos], b = errB[pos];
                if (r < 0) r = 0; else if (r > 255) r = 255;
                if (g < 0) g = 0; else if (g > 255) g = 255;
                if (b < 0) b = 0; else if (b > 255) b = 255;

                var hash = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
                var bestIdx;
                var cached = cache[hash];
                if (cached) {
                    bestIdx = cached - 1;
                } else {
                    bestIdx = 0;
                    var bestDist = 0x7FFFFFFF;
                    for (var pi = 0; pi < palCount; pi++) {
                        var dr = r - palette[pi * 3];
                        var dg = g - palette[pi * 3 + 1];
                        var db = b - palette[pi * 3 + 2];
                        var dist = dr * dr + dg * dg + db * db;
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestIdx = pi;
                            if (dist === 0) break;
                        }
                    }
                    cache[hash] = bestIdx + 1;
                }
                out[pos] = bestIdx;

                var er = r - palette[bestIdx * 3];
                var eg = g - palette[bestIdx * 3 + 1];
                var eb = b - palette[bestIdx * 3 + 2];

                // Floyd-Steinberg 误差传播
                // 右 (7/16)
                if (x < w - 1) {
                    var rp = pos + 1;
                    errR[rp] += er * 7 / 16;
                    errG[rp] += eg * 7 / 16;
                    errB[rp] += eb * 7 / 16;
                }
                // 左下 (3/16)
                if (x > 0 && y < h - 1) {
                    var rp = pos + w - 1;
                    errR[rp] += er * 3 / 16;
                    errG[rp] += eg * 3 / 16;
                    errB[rp] += eb * 3 / 16;
                }
                // 下 (5/16)
                if (y < h - 1) {
                    var rp = pos + w;
                    errR[rp] += er * 5 / 16;
                    errG[rp] += eg * 5 / 16;
                    errB[rp] += eb * 5 / 16;
                }
                // 右下 (1/16)
                if (x < w - 1 && y < h - 1) {
                    var rp = pos + w + 1;
                    errR[rp] += er * 1 / 16;
                    errG[rp] += eg * 1 / 16;
                    errB[rp] += eb * 1 / 16;
                }
            }
        }
        return out;
    }

    // ============================================================
    // 工具函数
    // ============================================================

    function loadImage(file) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () {
                var canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                var imageData = ctx.getImageData(0, 0, img.width, img.height);
                resolve({ imageData: imageData, width: img.width, height: img.height, name: file.name });
                URL.revokeObjectURL(img.src);
            };
            img.onerror = reject;
            img.src = URL.createObjectURL(file);
        });
    }

    function readFileAsText(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = reject;
            reader.readAsText(file);
        });
    }

    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    function getOptions() {
        var keepRes = document.getElementById('opt-keep-res').checked;
        var maxWVal = parseInt(document.getElementById('opt-max-width').value);
        var quality = document.getElementById('opt-quality').value;
        var maxColors = parseInt(document.getElementById('opt-colors').value) || 256;
        // 保持原始分辨率时 maxPxWidth=0（不缩放），否则按字符数转像素
        var maxPxWidth = keepRes ? 0 : ((isNaN(maxWVal) || maxWVal <= 0) ? 640 : maxWVal * 8);
        var dither = document.getElementById('opt-dither').value;

        // high 模式覆盖：256色 + FS抖动 + 原始分辨率
        if (quality === 'high') {
            maxColors = 256;
            maxPxWidth = 0;
            if (dither === 'none') dither = 'fs';
        }

        return {
            maxColors: maxColors,
            maxPxWidth: maxPxWidth,
            keepRes: keepRes,
            dither: dither,
            eightBit: document.getElementById('opt-8bit').checked,
            griLimit: document.getElementById('opt-gri-limit').checked,
            encodePolicy: document.getElementById('opt-encode').value,
            quality: quality,
        };
    }

    // ============================================================
    // 图片 → Sixel
    // ============================================================

    function convertToSixel(files, opts) {
        var statusEl = document.getElementById('convert-status');
        var progressEl = document.getElementById('convert-progress');
        progressEl.style.display = 'block';
        var results = [];
        var i = 0;

        function next() {
            if (i >= files.length) {
                progressEl.value = 100;
                statusEl.textContent = '完成: ' + results.filter(function(r){return !r.error;}).length + '/' + files.length + ' 个文件';
                showConvertResults(results);
                return;
            }
            var file = files[i];
            statusEl.textContent = '转换中: ' + file.name + ' (' + (i+1) + '/' + files.length + ')';
            progressEl.value = (i / files.length) * 100;

            loadImage(file).then(function (loaded) {
                var t0 = performance.now();
                var pp = preprocessImage(loaded.imageData, loaded.width, loaded.height, opts);
                var sixelData = window.SixelEncoder.encodeSixel(pp.pixels, pp.palette, pp.w, pp.h, opts);
                var elapsed = performance.now() - t0;
                results.push({
                    name: file.name.replace(/\.[^.]+$/, '.six'),
                    data: sixelData,
                    elapsed: elapsed,
                    width: pp.w, height: pp.h,
                    sixelSize: sixelData.length,
                    originalName: file.name
                });
                i++;
                setTimeout(next, 0);
            }).catch(function (e) {
                results.push({ name: file.name, error: e.message || String(e) });
                i++;
                setTimeout(next, 0);
            });
        }
        next();
    }

    function showConvertResults(results) {
        var el = document.getElementById('convert-results');
        el.innerHTML = '';
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (r.error) {
                el.innerHTML += '<div class="result error">❌ ' + r.name + ': ' + r.error + '</div>';
                continue;
            }
            var card = document.createElement('div');
            card.className = 'result-card';
            card.innerHTML =
                '<div class="result-info"><strong>' + r.name + '</strong><br>' +
                r.width + '×' + r.height + ' | ' + formatBytes(r.sixelSize) + ' | ' + r.elapsed.toFixed(0) + 'ms</div>';

            var dlBtn = document.createElement('button');
            dlBtn.textContent = '下载 .six';
            dlBtn.className = 'btn btn-sm';
            dlBtn.setAttribute('data-name', r.name);
            dlBtn.onclick = (function (name, data) {
                return function () { downloadBlob(new Blob([data]), name); };
            })(r.name, r.data);
            card.appendChild(dlBtn);

            // 预览
            try {
                var sixelText = new TextDecoder().decode(r.data);
                var previewCanvas = document.createElement('canvas');
                previewCanvas.className = 'preview-canvas';
                window.SixelDecoder.renderSixelToCanvas(sixelText, previewCanvas);
                card.appendChild(previewCanvas);
            } catch (e) { /* ignore */ }

            el.appendChild(card);
        }
    }

    // ============================================================
    // Sixel → 图片 + 预览
    // ============================================================

    var currentDecoded = null;

    function previewSixel(file) {
        var infoEl = document.getElementById('decode-info');
        var canvas = document.getElementById('decode-canvas');
        var exportArea = document.getElementById('decode-export');
        var previewCard = document.getElementById('decode-preview-card');

        readFileAsText(file).then(function (text) {
            try {
                var t0 = performance.now();
                var result = window.SixelDecoder.renderSixelToCanvas(text, canvas);
                var elapsed = performance.now() - t0;
                currentDecoded = { text: text, width: result.width, height: result.height, name: file.name };
                infoEl.textContent = file.name + ' | ' + result.width + '×' + result.height + ' | ' + formatBytes(file.size) + ' | 解码 ' + elapsed.toFixed(0) + 'ms';
                previewCard.style.display = 'block';
                exportArea.style.display = 'flex';
            } catch (e) {
                infoEl.textContent = '解码失败: ' + e.message;
                previewCard.style.display = 'block';
                exportArea.style.display = 'none';
            }
        }).catch(function (e) {
            infoEl.textContent = '文件读取失败: ' + (e.message || e);
            previewCard.style.display = 'block';
            exportArea.style.display = 'none';
        });
    }

    function exportDecoded(format) {
        if (!currentDecoded) return;
        var canvas = document.getElementById('decode-canvas');
        canvas.toBlob(function (blob) {
            var name = currentDecoded.name.replace(/\.six$/, '') + '.' + format;
            downloadBlob(blob, name);
        }, 'image/' + format);
    }

    // ============================================================
    // ZIP 写入器（Store 模式，零压缩，零依赖）
    // ============================================================

    function createZip(files) {
        // files: [{path: string, data: Uint8Array}]
        var localParts = [];
        var centralParts = [];
        var offset = 0;

        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            // 路径统一用正斜杠，编码为 UTF-8
            var normPath = f.path.replace(/\\/g, '/');
            var nameBytes = new TextEncoder().encode(normPath);
            var nameLen = nameBytes.length;
            var dataLen = f.data.length;

            // Local file header (30 + nameLen)
            var local = new Uint8Array(30 + nameLen);
            var lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034b50, true);  // signature
            lv.setUint16(4, 20, true);            // version needed
            lv.setUint16(6, 0x0800, true);        // flags: UTF-8 encoding
            lv.setUint16(8, 0, true);             // compression (store)
            lv.setUint16(10, 0, true);            // mod time
            lv.setUint16(12, 0, true);            // mod date
            lv.setUint32(14, crc32(f.data), true); // crc32
            lv.setUint32(18, dataLen, true);      // compressed size
            lv.setUint32(22, dataLen, true);      // uncompressed size
            lv.setUint16(26, nameLen, true);      // filename length
            lv.setUint16(28, 0, true);            // extra length
            for (var c = 0; c < nameLen; c++) local[30 + c] = nameBytes[c];

            localParts.push(local);
            localParts.push(f.data);

            // Central directory entry (46 + nameLen)
            var central = new Uint8Array(46 + nameLen);
            var cv = new DataView(central.buffer);
            cv.setUint32(0, 0x02014b50, true);   // signature
            cv.setUint16(4, 20, true);             // version made by
            cv.setUint16(6, 20, true);             // version needed
            cv.setUint16(8, 0x0800, true);         // flags: UTF-8
            cv.setUint16(10, 0, true);             // compression
            cv.setUint16(12, 0, true);             // mod time
            cv.setUint16(14, 0, true);             // mod date
            cv.setUint32(16, crc32(f.data), true); // crc32
            cv.setUint32(20, dataLen, true);       // compressed size
            cv.setUint32(24, dataLen, true);       // uncompressed size
            cv.setUint16(28, nameLen, true);       // filename length
            cv.setUint16(30, 0, true);             // extra length
            cv.setUint16(32, 0, true);             // comment length
            cv.setUint16(34, 0, true);             // disk number
            cv.setUint16(36, 0, true);             // internal attrs
            cv.setUint32(38, 0, true);             // external attrs
            cv.setUint32(42, offset, true);        // local header offset
            for (var c = 0; c < nameLen; c++) central[46 + c] = nameBytes[c];

            centralParts.push(central);
            offset += 30 + nameLen + dataLen;
        }

        // End of central directory (22 bytes)
        var cdOffset = offset;
        var cdSize = 0;
        for (var i = 0; i < centralParts.length; i++) cdSize += centralParts[i].length;

        var end = new Uint8Array(22);
        var ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(4, 0, true);
        ev.setUint16(6, 0, true);
        ev.setUint16(8, files.length, true);
        ev.setUint16(10, files.length, true);
        ev.setUint32(12, cdSize, true);
        ev.setUint32(16, cdOffset, true);
        ev.setUint16(20, 0, true);

        // 合并所有部分
        var totalLen = offset + cdSize + 22;
        var result = new Uint8Array(totalLen);
        var pos = 0;
        for (var i = 0; i < localParts.length; i++) {
            result.set(localParts[i], pos);
            pos += localParts[i].length;
        }
        for (var i = 0; i < centralParts.length; i++) {
            result.set(centralParts[i], pos);
            pos += centralParts[i].length;
        }
        result.set(end, pos);
        return new Blob([result], { type: 'application/zip' });
    }

    // CRC32 查找表
    var crc32Table = null;
    function getCrc32Table() {
        if (crc32Table) return crc32Table;
        crc32Table = new Uint32Array(256);
        for (var i = 0; i < 256; i++) {
            var c = i;
            for (var j = 0; j < 8; j++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            crc32Table[i] = c;
        }
        return crc32Table;
    }

    function crc32(data) {
        var table = getCrc32Table();
        var crc = 0xFFFFFFFF;
        for (var i = 0; i < data.length; i++) {
            crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    // ============================================================
    // ZIP 读取器（支持 Store 和 Deflate）
    // ============================================================

    function readZipFile(arrayBuffer) {
        var dv = new DataView(arrayBuffer);
        var buf = new Uint8Array(arrayBuffer);
        var len = buf.length;

        // 查找 End of Central Directory
        var eocdOffset = -1;
        for (var i = len - 22; i >= Math.max(0, len - 65557); i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
        }
        if (eocdOffset < 0) return Promise.reject(new Error('无效的 ZIP 文件'));

        var cdSize = dv.getUint32(eocdOffset + 12, true);
        var cdOffset = dv.getUint32(eocdOffset + 16, true);

        // 解析 Central Directory
        var entries = [];
        var pos = cdOffset;
        while (pos < cdOffset + cdSize) {
            if (dv.getUint32(pos, true) !== 0x02014b50) break;
            var flags = dv.getUint16(pos + 8, true);
            var compMethod = dv.getUint16(pos + 10, true);
            var compSize = dv.getUint32(pos + 20, true);
            var nameLen = dv.getUint16(pos + 28, true);
            var extraLen = dv.getUint16(pos + 30, true);
            var commentLen = dv.getUint16(pos + 32, true);
            var localOffset = dv.getUint32(pos + 42, true);
            var isUtf8 = (flags & 0x0800) !== 0;

            var nameBytes = buf.slice(pos + 46, pos + 46 + nameLen);
            var path = isUtf8
                ? new TextDecoder('utf-8').decode(nameBytes)
                : new TextDecoder('iso-8859-1').decode(nameBytes);

            entries.push({ path: path, compMethod: compMethod, compSize: compSize, localOffset: localOffset });
            pos += 46 + nameLen + extraLen + commentLen;
        }

        // 提取文件数据
        var stored = [];
        var deflatePromises = [];

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.path.endsWith('/')) continue;

            var lp = e.localOffset;
            if (dv.getUint32(lp, true) !== 0x04034b50) continue;
            var lNameLen = dv.getUint16(lp + 26, true);
            var lExtraLen = dv.getUint16(lp + 28, true);
            var dataOffset = lp + 30 + lNameLen + lExtraLen;
            var fileData = buf.slice(dataOffset, dataOffset + e.compSize);

            if (e.compMethod === 0) {
                stored.push({ path: e.path, data: fileData });
            } else if (e.compMethod === 8 && typeof DecompressionStream !== 'undefined') {
                deflatePromises.push(decompressDeflate(e.path, fileData));
            } else if (e.compMethod === 8) {
                deflatePromises.push(Promise.reject(new Error('浏览器不支持 Deflate 解压')));
            }
        }

        if (deflatePromises.length === 0) return Promise.resolve(stored);
        return Promise.all(deflatePromises).then(function(df) { return stored.concat(df); });
    }

    function decompressDeflate(path, compressedData) {
        return new Promise(function(resolve, reject) {
            try {
                var ds = new DecompressionStream('deflate-raw');
                var writer = ds.writable.getWriter();
                writer.write(compressedData);
                writer.close();
                var reader = ds.readable.getReader();
                var chunks = [];
                (function read() {
                    reader.read().then(function(result) {
                        if (result.done) {
                            var totalLen = 0;
                            for (var c = 0; c < chunks.length; c++) totalLen += chunks[c].length;
                            var merged = new Uint8Array(totalLen);
                            var off = 0;
                            for (var c = 0; c < chunks.length; c++) { merged.set(chunks[c], off); off += chunks[c].length; }
                            resolve({ path: path, data: merged });
                        } else {
                            chunks.push(result.value);
                            read();
                        }
                    }).catch(reject);
                })();
            } catch (e) { reject(e); }
        });
    }

    // ============================================================
    // 批量编码（文件夹 → Sixel）
    // ============================================================

    var IMAGE_EXTS = /\.(png|jpe?g|gif|bmp|webp)$/i;

    function batchConvertFolder(files, opts) {
        var statusEl = document.getElementById('convert-status');
        var progressEl = document.getElementById('convert-progress');
        progressEl.style.display = 'block';

        // 过滤图片文件，保留相对路径
        var imageFiles = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var relPath = f.webkitRelativePath || f.name;
            if (IMAGE_EXTS.test(relPath)) {
                imageFiles.push({ file: f, path: relPath });
            }
        }

        if (!imageFiles.length) {
            statusEl.textContent = '文件夹中未找到图片文件';
            progressEl.style.display = 'none';
            return;
        }

        var results = [];
        var idx = 0;

        function next() {
            if (idx >= imageFiles.length) {
                progressEl.value = 100;
                var ok = results.filter(function(r){return !r.error;}).length;
                statusEl.textContent = '完成: ' + ok + '/' + imageFiles.length + ' 个文件';
                showBatchConvertResults(results);
                return;
            }
            var entry = imageFiles[idx];
            var currentIdx = idx;
            statusEl.textContent = '转换中: ' + entry.path + ' (' + (idx+1) + '/' + imageFiles.length + ')';
            progressEl.value = (idx / imageFiles.length) * 100;

            (function(entry, currentIdx) {
                loadImage(entry.file).then(function (loaded) {
                    var t0 = performance.now();
                    var pp = preprocessImage(loaded.imageData, loaded.width, loaded.height, opts);
                    var sixelData = window.SixelEncoder.encodeSixel(pp.pixels, pp.palette, pp.w, pp.h, opts);
                    var elapsed = performance.now() - t0;
                    var outPath = entry.path.replace(/\.[^.]+$/, '.six');
                    results.push({
                        path: outPath,
                        data: sixelData,
                        elapsed: elapsed,
                        width: pp.w, height: pp.h,
                        size: sixelData.length
                    });
                    idx++;
                    setTimeout(next, 0);
                }).catch(function (e) {
                    results.push({ path: entry.path, error: e.message || String(e) });
                    idx++;
                    setTimeout(next, 0);
                });
            })(entry, currentIdx);
        }
        next();
    }

    function showBatchConvertResults(results) {
        var card = document.getElementById('batch-convert-results');
        var info = document.getElementById('batch-convert-info');
        var list = document.getElementById('batch-convert-list');
        card.style.display = 'block';

        var ok = results.filter(function(r){return !r.error;}).length;
        info.textContent = ok + '/' + results.length + ' 个文件转换成功';

        list.innerHTML = '';
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            var item = document.createElement('div');
            item.className = 'batch-item' + (r.error ? ' error' : '');
            if (r.error) {
                item.innerHTML = '<div class="batch-item-name" title="' + r.path + '">' + r.path + '</div>' +
                    '<div class="batch-item-error">❌ ' + r.error + '</div>';
            } else {
                item.innerHTML = '<div class="batch-item-name" title="' + r.path + '">' + r.path + '</div>' +
                    '<div class="batch-item-info">' + r.width + '×' + r.height + ' | ' + formatBytes(r.size) + ' | ' + r.elapsed.toFixed(0) + 'ms</div>';
            }
            list.appendChild(item);
        }

        // 绑定 ZIP 下载
        document.getElementById('batch-convert-zip').onclick = function () {
            var zipFiles = [];
            for (var i = 0; i < results.length; i++) {
                if (!results[i].error) {
                    zipFiles.push({ path: results[i].path, data: results[i].data });
                }
            }
            if (zipFiles.length) {
                downloadBlob(createZip(zipFiles), 'sixel-batch.zip');
            }
        };
    }

    // ============================================================
    // 批量解码（文件夹 → PNG）
    // ============================================================

    var SIXEL_EXTS = /\.(six|sixel|txt)$/i;

    function batchDecodeFolder(files) {
        var filtered = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var relPath = f.webkitRelativePath || f.name;
            if (SIXEL_EXTS.test(relPath)) {
                filtered.push({ file: f, path: relPath });
            }
        }
        runBatchDecode(filtered);
    }

    function batchDecodeFromZip(files) {
        var filtered = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var relPath = f._zipPath || f.name;
            if (SIXEL_EXTS.test(relPath)) {
                filtered.push({ file: f, path: relPath });
            }
        }
        runBatchDecode(filtered);
    }

    function runBatchDecode(sixFiles) {
        var infoEl = document.getElementById('batch-decode-info');
        var resultsCard = document.getElementById('batch-decode-results');
        var list = document.getElementById('batch-decode-list');
        resultsCard.style.display = 'block';
        list.innerHTML = '';

        if (!sixFiles.length) {
            infoEl.textContent = '未找到 .six/.sixel 文件';
            return;
        }

        infoEl.textContent = '解码中... 0/' + sixFiles.length;
        var results = [];
        var idx = 0;

        function next() {
            if (idx >= sixFiles.length) {
                var ok = results.filter(function(r){return !r.error;}).length;
                infoEl.textContent = ok + '/' + sixFiles.length + ' 个文件解码成功';
                bindBatchDecodeButtons(results);
                return;
            }
            var entry = sixFiles[idx];
            var currentIdx = idx;
            infoEl.textContent = '解码中... ' + (idx+1) + '/' + sixFiles.length + ' ' + entry.path;

            (function(entry, currentIdx) {
                readFileAsText(entry.file).then(function (text) {
                    try {
                        var t0 = performance.now();
                        var decoded = window.SixelDecoder.decodeSixel(text);
                        var elapsed = performance.now() - t0;

                        // 生成缩略图
                        var thumbCanvas = document.createElement('canvas');
                        thumbCanvas.width = decoded.width;
                        thumbCanvas.height = decoded.height;
                        var ctx = thumbCanvas.getContext('2d');
                        ctx.putImageData(new ImageData(decoded.pixels, decoded.width, decoded.height), 0, 0);
                        var thumbUrl = thumbCanvas.toDataURL('image/png', 0.5);

                        // 转为 PNG Blob
                        var outPath = entry.path.replace(/\.[^.]+$/, '.png');
                        var pngData = dataUrlToUint8Array(thumbCanvas.toDataURL('image/png'));

                        results.push({
                            path: outPath,
                            data: pngData,
                            thumbUrl: thumbUrl,
                            width: decoded.width,
                            height: decoded.height,
                            size: entry.file.size,
                            elapsed: elapsed
                        });

                        // 添加到列表
                        var item = document.createElement('div');
                        item.className = 'batch-item';
                        item.innerHTML = '<img class="batch-thumb" src="' + thumbUrl + '" alt="' + entry.path + '">' +
                            '<div class="batch-item-name" title="' + entry.path + '">' + entry.path + '</div>' +
                            '<div class="batch-item-info">' + decoded.width + '×' + decoded.height + ' | ' + formatBytes(entry.file.size) + ' | ' + elapsed.toFixed(0) + 'ms</div>';
                        list.appendChild(item);
                    } catch (e) {
                        results.push({ path: entry.path, error: e.message });
                        var item = document.createElement('div');
                        item.className = 'batch-item error';
                        item.innerHTML = '<div class="batch-item-name" title="' + entry.path + '">' + entry.path + '</div>' +
                            '<div class="batch-item-error">❌ ' + e.message + '</div>';
                        list.appendChild(item);
                    }
                    idx++;
                    setTimeout(next, 0);
                }).catch(function (e) {
                    results.push({ path: entry.path, error: e.message || String(e) });
                    var item = document.createElement('div');
                    item.className = 'batch-item error';
                    item.innerHTML = '<div class="batch-item-name" title="' + entry.path + '">' + entry.path + '</div>' +
                        '<div class="batch-item-error">❌ ' + (e.message || e) + '</div>';
                    list.appendChild(item);
                    idx++;
                    setTimeout(next, 0);
                });
            })(entry, currentIdx);
        }
        next();
    }

    function dataUrlToUint8Array(dataUrl) {
        var base64 = dataUrl.split(',')[1];
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function bindBatchDecodeButtons(results) {
        // ZIP 下载
        document.getElementById('batch-decode-zip').onclick = function () {
            var zipFiles = [];
            for (var i = 0; i < results.length; i++) {
                if (!results[i].error) {
                    zipFiles.push({ path: results[i].path, data: results[i].data });
                }
            }
            if (zipFiles.length) {
                downloadBlob(createZip(zipFiles), 'decoded-batch.zip');
            }
        };
        // 全部导出 PNG（逐个下载）
        document.getElementById('batch-decode-png').onclick = function () {
            for (var i = 0; i < results.length; i++) {
                if (!results[i].error) {
                    (function(path, data) {
                        setTimeout(function () {
                            downloadBlob(new Blob([data], {type: 'image/png'}), path);
                        }, 0);
                    })(results[i].path, results[i].data);
                }
            }
        };
    }

    // ============================================================
    // 设置持久化 (localStorage)
    // ============================================================

    var SETTINGS_KEY = 'sixel-web-settings';

    var SETTINGS_IDS = [
        'opt-colors', 'opt-keep-res', 'opt-max-width',
        'opt-encode', 'opt-quality',
        'opt-dither', 'opt-8bit', 'opt-gri-limit'
    ];

    function saveSettings() {
        var data = {};
        for (var i = 0; i < SETTINGS_IDS.length; i++) {
            var el = document.getElementById(SETTINGS_IDS[i]);
            if (!el) continue;
            data[SETTINGS_IDS[i]] = el.type === 'checkbox' ? el.checked : el.value;
        }
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch (e) {}
    }

    function loadSettings() {
        var raw;
        try { raw = localStorage.getItem(SETTINGS_KEY); } catch (e) {}
        if (!raw) return;
        var data;
        try { data = JSON.parse(raw); } catch (e) { return; }
        for (var i = 0; i < SETTINGS_IDS.length; i++) {
            var id = SETTINGS_IDS[i];
            if (data[id] === undefined) continue;
            var el = document.getElementById(id);
            if (!el) continue;
            if (el.type === 'checkbox') {
                el.checked = !!data[id];
            } else {
                el.value = data[id];
            }
        }
    }

    // ============================================================
    // 初始化
    // ============================================================

    function init() {
        // 恢复设置
        loadSettings();

        // 颜色滑块
        var slider = document.getElementById('opt-colors');
        var valSpan = document.getElementById('opt-colors-value');
        valSpan.textContent = slider.value;
        slider.addEventListener('input', function () { valSpan.textContent = slider.value; });

        // 保持原始分辨率 复选框联动
        var keepResCb = document.getElementById('opt-keep-res');
        var maxWInput = document.getElementById('opt-max-width');
        var maxWLabel = document.getElementById('max-width-label');
        function updateMaxWState() {
            maxWInput.disabled = keepResCb.checked;
            maxWLabel.style.opacity = keepResCb.checked ? '0.4' : '1';
        }
        updateMaxWState();
        keepResCb.addEventListener('change', updateMaxWState);

        // 任意设置变更时自动保存
        for (var i = 0; i < SETTINGS_IDS.length; i++) {
            var el = document.getElementById(SETTINGS_IDS[i]);
            if (!el) continue;
            el.addEventListener('change', saveSettings);
            if (el.type === 'range') el.addEventListener('input', saveSettings);
        }

        // Tab 切换
        var tabs = document.querySelectorAll('.tab');
        for (var t = 0; t < tabs.length; t++) {
            tabs[t].addEventListener('click', function () {
                for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
                var contents = document.querySelectorAll('.tab-content');
                for (j = 0; j < contents.length; j++) contents[j].classList.remove('active');
                this.classList.add('active');
                document.getElementById('tab-' + this.getAttribute('data-tab')).classList.add('active');
            });
        }

        // 转换按钮
        document.getElementById('convert-btn').addEventListener('click', function () {
            var files = document.getElementById('convert-files').files;
            if (!files.length) { alert('请选择图片文件'); return; }
            convertToSixel(Array.from(files), getOptions());
        });

        // 批量编码：选择文件夹
        document.getElementById('convert-folder').addEventListener('change', function (e) {
            if (e.target.files.length) {
                batchConvertFolder(Array.from(e.target.files), getOptions());
            }
        });

        // Sixel 预览
        document.getElementById('decode-file').addEventListener('change', function (e) {
            if (e.target.files[0]) previewSixel(e.target.files[0]);
        });

        // 批量解码：选择文件夹
        document.getElementById('decode-folder').addEventListener('change', function (e) {
            if (e.target.files.length) {
                batchDecodeFolder(Array.from(e.target.files));
            }
        });

        // 批量解码：选择 ZIP 文件
        document.getElementById('decode-zip').addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function () {
                readZipFile(reader.result).then(function (zipFiles) {
                    // 将解压的文件转为 File 对象供 batchDecodeFolder 使用
                    var files = [];
                    for (var i = 0; i < zipFiles.length; i++) {
                        var zf = zipFiles[i];
                        var blob = new Blob([zf.data]);
                        var f = new File([blob], zf.path.split('/').pop());
                        // 模拟 webkitRelativePath 保留路径
                        Object.defineProperty(f, '_zipPath', { value: zf.path });
                        files.push(f);
                    }
                    batchDecodeFromZip(files);
                }).catch(function (err) {
                    alert('ZIP 解析失败: ' + err.message);
                });
            };
            reader.onerror = function () { alert('文件读取失败'); };
            reader.readAsArrayBuffer(file);
            // 重置 input 以允许重复选择同一文件
            e.target.value = '';
        });

        // 导出按钮
        document.getElementById('export-png').addEventListener('click', function () { exportDecoded('png'); });
        document.getElementById('export-jpeg').addEventListener('click', function () { exportDecoded('jpeg'); });

        // 拖放
        var dropZone = document.getElementById('decode-dropzone');
        dropZone.addEventListener('dragover', function (e) { e.preventDefault(); this.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', function () { this.classList.remove('dragover'); });
        dropZone.addEventListener('drop', function (e) {
            e.preventDefault();
            this.classList.remove('dragover');
            if (e.dataTransfer.files[0]) previewSixel(e.dataTransfer.files[0]);
        });
        // <label for="decode-file"> 已自动处理点击触发，无需 JS .click()
        // 仅保留拖放支持
    }

    document.addEventListener('DOMContentLoaded', init);
})();
