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

        // 量化
        var result;
        if (opts.quality === 'high') {
            result = window.Quantize.pnnQuant(quantInput.data, targetW, targetH, maxColors);
        } else {
            result = window.Quantize.medianCut(quantInput.data, targetW, targetH, maxColors);
        }

        // Floyd-Steinberg 后处理误差扩散（量化后）
        if (ditherMode === 'fs') {
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

        // Sixel 预览
        document.getElementById('decode-file').addEventListener('change', function (e) {
            if (e.target.files[0]) previewSixel(e.target.files[0]);
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
        dropZone.addEventListener('click', function () {
            document.getElementById('decode-file').click();
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
