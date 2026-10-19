#!/usr/bin/env python3
"""生成 EasyCharles 应用图标（1024×1024 PNG）。

设计：深色圆角方块（macOS Big Sur 之后的图标留白与圆角比例）+ 一进一回两个箭头，
对应「请求转发出去 / 响应带回来」这一核心动作。

用法：make-icon.py <输出 png 路径>
"""

import sys

from PIL import Image, ImageDraw

# macOS 图标规范：内容区约占 824/1024，圆角半径约为内容边长的 22.37%
CANVAS = 1024
MARGIN = 100
RADIUS_RATIO = 0.2237

# 配色
BG_TOP = (41, 58, 98)  # 深藏青
BG_BOTTOM = (15, 22, 41)  # 更深，做出自上而下的纵深
ARROW_OUT = (56, 189, 248)  # 请求：亮青
ARROW_IN = (129, 140, 248)  # 响应：靛紫


def rounded_mask(size: int, radius: int, scale: int) -> Image.Image:
    """超采样绘制圆角矩形遮罩，降采样后边缘平滑无锯齿。"""
    big = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1), radius=radius * scale, fill=255
    )
    return big.resize((size, size), Image.LANCZOS)


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return grad.resize((size, size), Image.BILINEAR)


def arrow_points(x_tail: int, x_tip: int, y: int, shaft: int, head_len: int, head: int):
    """构造一个水平箭头的多边形顶点。

    x_tail/x_tip 为尾端与尖端；方向由二者大小关系决定（x_tip > x_tail 即向右）。
    """
    sign = 1 if x_tip > x_tail else -1
    x_neck = x_tip - sign * head_len
    return [
        (x_tail, y - shaft // 2),
        (x_neck, y - shaft // 2),
        (x_neck, y - head // 2),
        (x_tip, y),
        (x_neck, y + head // 2),
        (x_neck, y + shaft // 2),
        (x_tail, y + shaft // 2),
    ]


def build(out_path: str) -> None:
    scale = 4
    content = CANVAS - MARGIN * 2
    radius = round(content * RADIUS_RATIO)

    # 背景层（带渐变）
    layer = Image.new("RGB", (CANVAS, CANVAS), BG_TOP)
    layer.paste(vertical_gradient(content, BG_TOP, BG_BOTTOM), (MARGIN, MARGIN))

    # 箭头层（先画在透明图上，再按遮罩贴回，保证不越出圆角）
    arrows = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(arrows)

    left = MARGIN + round(content * 0.17)
    right = MARGIN + content - round(content * 0.17)
    shaft = round(content * 0.105)
    head_len = round(content * 0.20)
    head = round(content * 0.30)
    y_out = MARGIN + round(content * 0.355)  # 上行：请求，向右
    y_in = MARGIN + round(content * 0.645)  # 下行：响应，向左

    d.polygon(arrow_points(left, right, y_out, shaft, head_len, head), fill=ARROW_OUT + (255,))
    d.polygon(arrow_points(right, left, y_in, shaft, head_len, head), fill=ARROW_IN + (255,))

    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.paste(layer, (0, 0))
    out = Image.alpha_composite(out, arrows)

    # 用圆角遮罩裁掉四角
    mask = rounded_mask(CANVAS, radius, scale)
    final = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    final.paste(out, (0, 0), mask)

    final.save(out_path, "PNG")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法: make-icon.py <输出 png 路径>", file=sys.stderr)
        sys.exit(2)
    build(sys.argv[1])
