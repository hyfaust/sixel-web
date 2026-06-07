# libsixel 编码性能优化分析

基于 libsixel 1.8.7 源码（`quant.c`、`encoder.c`、`tosixel.c`）的性能优化手段详细分析。

---

## 一、量化与色彩映射（quant.c）

### 1.1 15-bit 完美哈希

```c
static unsigned int
computeHash(unsigned char const *data, unsigned int const depth)
{
    unsigned int hash = 0;
    for (unsigned int n = 0; n < depth; n++) {
        hash |= (unsigned int)(data[depth - 1 - n] >> 3) << n * 5;
    }
    return hash;
}
```

- 每通道只取高 5 位（`>> 3`），RGB 三通道合并为 15-bit 哈希值
- 哈希空间 = 2^15 = **32768**，等效于 8×8×8 的颜色立方体
- 仅用位移和 OR 运算，无乘除法
- 由于量化粒度与哈希粒度完全一致（都是丢弃低 3 位），**不存在哈希冲突**——这是一个完美哈希设计

### 1.2 直方图构建（computeHistogram）

```c
histogram = calloc(1 << depth * 5, sizeof(unsigned short));
for (i = 0; i < length; i += step) {
    bucket_index = computeHash(data + i, 3);
    if (histogram[bucket_index] == 0) *ref++ = bucket_index;
    if (histogram[bucket_index] < 65535) histogram[bucket_index]++;
}
```

**优化要点：**

| 技巧 | 说明 |
|------|------|
| 直接映射数组 | `histogram[bucket_index]++` 直接索引，无链表/冲突处理 |
| `unsigned short` | 16-bit 计数器，32768 × 2B = **64KB**，完全在 L1 缓存内 |
| 引用映射表（refmap） | 构建直方图时同步记录非零桶索引，后续只遍历有效条目 |
| 饱和保护 | `if (histogram[...] < 65535)` 防止溢出 |

#### 质量模式控制采样步长

```c
switch (qualityMode) {
    case SIXEL_QUALITY_LOW:  max_sample = 18383;   break;  // ~1.8 万
    case SIXEL_QUALITY_HIGH: max_sample = 1118383;  break;  // ~112 万
    case SIXEL_QUALITY_FULL: max_sample = 4003079;  break;  // ~400 万
}
step = length / depth / max_sample * depth;
if (step <= 0) step = depth;
```

- 当像素数超过 `max_sample` 时，循环以 `step > depth` 步进，**均匀跳过像素**
- 将直方图计算量从 O(pixels) 降至 O(max_sample)
- LOW 模式下，1863×1290 图仅采样 ~1.8 万像素（~0.75%）

### 1.3 O(1) 颜色查找缓存（lookup_fast）

```c
static int
lookup_fast(unsigned char const *pixel, ..., unsigned short *cachetable, ...)
{
    hash = computeHash(pixel, 3);
    cache = cachetable[hash];
    if (cache) return cache - 1;       // 缓存命中：O(1)

    // 缓存未命中：O(reqcolor) 线性扫描
    for (i = 0; i < reqcolor; i++) {
        distant = (pixel[0]-pal[i*3+0]) * (pixel[0]-pal[i*3+0]) * complexion
                + (pixel[1]-pal[i*3+1]) * (pixel[1]-pal[i*3+1])
                + (pixel[2]-pal[i*3+2]) * (pixel[2]-pal[i*3+2]);
        if (distant < diff) { diff = distant; result = i; }
    }
    cachetable[hash] = result + 1;     // 填入缓存（+1 偏移，0=未缓存）
    return result;
}
```

**关键设计：**

- **cachetable 使用 +1 偏移**：用 0 表示"未缓存"，`cache - 1` 还原索引，一次判断 `if (cache)` 即可区分命中/未命中
- **自然图像缓存命中率极高**：量化后仅 256 色，哈希空间 32768 桶，大部分同色像素都命中缓存
- **肤色校正（complexion）**：R 通道权重加倍，内联在距离计算中，无额外分支
- 这是 **FS 误差扩散阶段最大的性能瓶颈优化**——每个像素都要做一次颜色查找

### 1.4 查找策略函数指针

`sixel_quant_apply_palette()` 通过函数指针选择最优查找策略：

| 条件 | 策略 | 复杂度 |
|------|------|--------|
| 2 色且纯黑白 | `lookup_mono_darkbg` / `lookup_mono_lightbg` | O(depth)，直接阈值判断 |
| depth==3 且优化开启 | `lookup_fast` | O(1) 摊还 |
| 其他 | `lookup_normal` | O(reqcolor × depth) |

`lookup_mono_*` 仅对所有通道求和并与 `128 * depth` 比较，完全跳过距离计算。

### 1.5 Median Cut 短路

```c
if (colorfreqtable.size <= reqColors) {
    // 直接拷贝，跳过 O(n log n) 排序 + 递归分裂
    colormapP->size = colorfreqtable.size;
} else {
    mediancut(...);
}
```

当独特颜色数 ≤ 目标色数时，完全跳过 Median Cut 算法。

### 1.6 Median Cut 分割策略

```c
// 选择最大范围维度
switch (methodForLargest) {
    case SIXEL_LARGE_NORM: largestDimension = largestByNorm(minval, maxval, depth);
    case SIXEL_LARGE_LUM:  largestDimension = largestByLuminosity(minval, maxval, depth);
}

// 按该维度排序后，按像素数中位数分割（非颜色数中位数）
lowersum = colorfreqtable.table[boxStart]->value;
for (i = 1; i < boxSize - 1 && lowersum < sm / 2; ++i) {
    lowersum += colorfreqtable.table[boxStart + i]->value;
}
medianIndex = i;
```

- `SIXEL_LARGE_LUM` 按亮度加权选择分割维度，比纯 RGB 范围更符合人眼感知
- 按**像素数中位数**分割（非颜色数），确保每半包含约一半像素

### 1.7 单次分配池（alloctupletable）

```c
allocSize = mainTableSize + size * tupleIntSize;
pool = malloc(allocSize);
for (i = 0; i < size; ++i)
    tbl[i] = (struct tupleint *)((char*)pool + mainTableSize + i * tupleIntSize);
```

- 指针数组 + 所有 `tupleint` 结构体在**一次 malloc 中连续分配**
- 避免 N 次独立 malloc 的系统调用开销和内存碎片
- 连续内存布局对 CPU 缓存预取友好

---

## 二、编码流水线（encoder.c）

### 2.1 自动禁用误差扩散

```c
histogram_colors = sixel_dither_get_num_of_histogram_colors(*dither);
if (histogram_colors <= encoder->reqcolors) {
    encoder->method_for_diffuse = SIXEL_DIFFUSE_NONE;
}
```

当原始独特颜色数 ≤ 目标色数时，自动跳过 Floyd-Steinberg 等误差扩散（O(pixels × kernel_size)）。

### 2.2 Dither 缓存（动画场景）

```c
if (encoder->dither_cache) {
    *dither = encoder->dither_cache;  // 直接复用，跳过量化
    goto end;
}
```

GIF 等多帧场景中，第一帧完成量化后，后续帧直接复用同一个 dither 对象。

### 2.3 宏定义编码（动画帧压缩）

```c
sixel_encoder_output_with_macro()
```

- 首帧编码为 DCS 宏定义（`\033P#;0;1!z ... \033\\`）
- 重复帧仅发送宏调用指令（`\033[#*z`）
- 将重复帧的输出从数千字节降到几个字节

### 2.4 精确帧时序控制

```c
start = clock();
// ... 编码 ...
dulation = (clock() - start) * 1000000 / CLOCKS_PER_SEC - lag;
remaining_usec = target_usec - dulation;
if (remaining_usec > 0) nanosleep(...);
else lag = remaining_usec;  // 累积延迟补偿
```

使用 `clock()` 测量编码耗时，只 sleep 剩余时间，累积 lag 做补偿。

---

## 三、Sixel 输出编码（tosixel.c）

### 3.1 16KB 输出缓冲区 + 滑动窗口

```c
#define SIXEL_OUTPUT_PACKET_SIZE 16384

static void sixel_advance(sixel_output_t *output, int nwrite) {
    if ((output->pos += nwrite) >= SIXEL_OUTPUT_PACKET_SIZE) {
        output->fn_write(output->buffer, SIXEL_OUTPUT_PACKET_SIZE, output->priv);
        memcpy(output->buffer,
               output->buffer + SIXEL_OUTPUT_PACKET_SIZE,
               output->pos -= SIXEL_OUTPUT_PACKET_SIZE);
    }
}
```

- 积累 16KB 后一次性写入，系统调用次数从 O(bytes) 降到 O(bytes/16384)
- 滑动窗口：只刷新前 16KB，尾部残留通过 `memcpy` 前移

### 3.2 游程编码（RLE）

```c
static void sixel_put_pixel(sixel_output_t *output, int pix) {
    pix += '?';
    if (pix == output->save_pixel) {
        output->save_count++;
    } else {
        sixel_put_flash(output);  // 刷出之前累积
        output->save_pixel = pix;
        output->save_count = 1;
    }
}

static void sixel_put_flash(sixel_output_t *output) {
    if (output->save_count > 3) {
        // DECGRI: !count + char（节省空间）
        sixel_putc('!');
        sixel_putnum(output->save_count);
        sixel_putc(output->save_pixel);
    } else {
        // 短游程逐字输出（!Nc 格式本身至少 3 字符）
        for (n = 0; n < output->save_count; n++)
            output->buffer[output->pos++] = output->save_pixel;
    }
}
```

- **阈值为 3**：`!Nc` 格式本身需要至少 3 字符（`!` + 数字 + 字符），重复 ≤ 3 次时逐字输出更短
- VT240 兼容模式限制 DECGRI 参数最大 255，超过时分段

### 3.3 整数转字符串优化

```c
static int sixel_putnum_impl(char *buffer, long value, int pos) {
    ldiv_t r = ldiv(value, 10);
    if (r.quot > 0) pos = sixel_putnum_impl(buffer, r.quot, pos);
    *(buffer + pos) = '0' + r.rem;
    return pos + 1;
}
```

使用 `ldiv()` 递归提取数字位，比 `sprintf("%d", ...)` 快得多——避免格式字符串解析、宽度/精度处理等开销。

### 3.4 对象池（node_free 链表）

```c
// 从空闲列表获取节点
if ((np = output->node_free) != NULL) {
    output->node_free = np->next;  // 复用已释放节点
} else {
    sixel_node_new(&np, allocator);  // 仅在空闲列表为空时分配
}
```

释放的节点不归还系统堆，放入 `node_free` 链表复用，大幅减少 malloc/free 调用。

### 3.5 节点排序最小化回车

```c
// 按 sx 排序插入链表
while (tp->next != NULL) {
    if (np->sx < tp->next->sx) break;
    else if (np->sx == tp->next->sx && np->mx > tp->next->mx) break;
    tp = tp->next;
}
```

- 按起始 x 坐标排序，输出时从左到右顺序扫描
- 只在 `x > np->sx` 时发 `$`（回车），最少化回车次数
- 同 sx 时宽区间优先，减少分段

### 3.6 调色板切换追踪

```c
if (output->active_palette != np->pal) {
    sixel_putc('#');
    sixel_putnum(np->pal);
    output->active_palette = np->pal;
}
```

仅在调色板索引实际变化时输出 `#N` 切换命令。

### 3.7 6 行带打包 + memset 批量填充

```c
for (y = 0; y < height; y++) {
    map[pix * width + x] |= (1 << i);  // 第 i 行的位
    if (++i < 6 && (y + 1) < height) continue;
    // 收集满 6 行后编码输出
    i = 0;
    memset(map, 0, len);  // 重置
}

// 整行可填充时使用 memset
if (fillable) {
    memset(np->map + np->sx, (1 << i) - 1, np->mx - np->sx);
}
```

- Sixel 格式每列 6 像素（6bit），代码将 6 行合并处理
- 整行同色时用 `memset` 一次性填充位掩码，跳过逐像素位运算

### 3.8 High-Color 模式 15-bit 直接映射

```c
// R5G5B5 直接索引
pix = ((pixels[0] & 0xf8) << 7) |
      ((pixels[1] & 0xf8) << 2) |
      ((pixels[2] >> 3) & 0x1f);

if (!rgbhit[pix]) { /* 首次遇到，分配调色板 */ }
else { *dst = rgb2pal[pix]; }  // O(1) 映射
```

- `rgbhit[32768]` 和 `rgb2pal[32768]` 两个 flat 数组，以 15-bit 颜色值为下标
- 查找和插入都是 O(1)，完全消除哈希冲突
- 多轮渐进策略：threshold 从 1 → 9 → 255 逐轮放宽，优先保留高频颜色
- 已绘制标记（marks 数组）避免重复量化

---

## 四、优化层次总结

| 层次 | 优化手段 | 效果 |
|------|---------|------|
| **算法** | 采样控制直方图计算量 | O(max_sample) 替代 O(pixels) |
| **算法** | Median Cut 短路 | 颜色少时跳过 O(n log n) |
| **算法** | 自动禁用扩散 | 颜色少时跳过 O(pixels × kernel) |
| **算法** | 按亮度选择分割维度 | 更符合人眼感知 |
| **数据结构** | 15-bit 完美哈希 | O(1) 直方图插入 |
| **数据结构** | cachetable +1 偏移 | O(1) 摊还颜色查找 |
| **数据结构** | 对象池（node_free） | 避免运行时 malloc |
| **内存** | 单次分配池 | 消除 N 次 malloc |
| **内存** | 16KB 输出缓冲区 | 减少 write() 系统调用 |
| **内存** | unsigned short 直方图 | 64KB，在 L1 缓存内 |
| **内存** | 连续内存布局 | CPU 缓存预取友好 |
| **编码** | RLE（阈值=3） | 压缩连续重复像素 |
| **编码** | 节点排序最小化回车 | 减少 `$` 控制字符 |
| **编码** | 调色板切换追踪 | 避免冗余 `#N` 命令 |
| **编码** | ldiv 整数转字符串 | 替代 sprintf |
| **编码** | memset 批量填充 | 跳过逐像素位运算 |
| **架构** | 宏定义编码动画帧 | 重复帧仅发宏调用 |
| **架构** | dither_cache 多帧复用 | 避免重复量化 |
| **架构** | 函数指针策略模式 | 零开销选择最优路径 |
