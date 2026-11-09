"""Render docs/dsh-update-flowchart.png.

This is a documentation-only helper. It needs Pillow and a CJK font; the DSH
bundled Python already provides Pillow. Run from the repository root:

    python tools/render-update-flow.py
"""
from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "dsh-update-flowchart.png"

W, H = 1900, 2980
BG = "#f3f6fb"
INK = "#16202c"
MUTED = "#4b5868"
ARROW = "#5f6b7a"
BLUE = "#2f6feb"
GREEN = "#2e7d32"
AMBER = "#b77900"
RED = "#c0392b"

FONT_CANDIDATES = [
    ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"),
    ("/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/PingFang.ttc"),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
]


def pick_fonts() -> tuple[str, str]:
    for regular, bold in FONT_CANDIDATES:
        if os.path.exists(regular) and os.path.exists(bold):
            return regular, bold
    raise SystemExit("no CJK font found; install Microsoft YaHei or Noto Sans CJK")


regular_path, bold_path = pick_fonts()
img = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(img)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(bold_path if bold else regular_path, size)


TITLE = font(46, True)
SUBTITLE = font(22)
NODE_TITLE = font(25, True)
BODY = font(20)
SMALL = font(18)
LABEL = font(19, True)
LEGEND = font(20)


def text_width(text: str, f: ImageFont.FreeTypeFont) -> float:
    return draw.textlength(text, font=f)


def wrap(text: str, f: ImageFont.FreeTypeFont, max_width: float) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        if paragraph == "":
            lines.append("")
            continue
        current = ""
        for char in paragraph:
            if text_width(current + char, f) <= max_width:
                current += char
            else:
                lines.append(current)
                current = char
        lines.append(current)
    return lines


def centered(lines: list[str], cx: float, top: float, f: ImageFont.FreeTypeFont, fill: str, spacing: int) -> float:
    y = top
    for line in lines:
        draw.text((cx - text_width(line, f) / 2, y), line, font=f, fill=fill)
        y += spacing
    return y


def box(x0: float, y0: float, x1: float, y1: float, title: str, body: str,
        fill: str = "#ffffff", border: str = BLUE) -> None:
    draw.rounded_rectangle([x0, y0, x1, y1], radius=18, fill=fill, outline=border, width=3)
    centered([title], (x0 + x1) / 2, y0 + 15, NODE_TITLE, INK, 32)
    y = y0 + 62
    if body:
        lines = wrap(body, BODY, x1 - x0 - 48)
        centered(lines, (x0 + x1) / 2, y, BODY, MUTED, 28)


def diamond(cx: float, y0: float, y1: float, text: str) -> None:
    cy = (y0 + y1) / 2
    half = 250
    points = [(cx, y0), (cx + half, cy), (cx, y1), (cx - half, cy)]
    draw.polygon(points, fill="#fff8e6", outline=AMBER, width=3)
    lines = text.split("\n")
    centered(lines, cx, cy - len(lines) * 16, font(24, True), INK, 34)


def arrowhead(points: list[tuple[float, float]], color: str = ARROW, size: int = 13) -> None:
    (x1, y1), (x2, y2) = points[-2], points[-1]
    angle = math.atan2(y2 - y1, x2 - x1)
    left = (x2 + size * math.cos(angle + math.radians(150)), y2 + size * math.sin(angle + math.radians(150)))
    right = (x2 + size * math.cos(angle - math.radians(150)), y2 + size * math.sin(angle - math.radians(150)))
    draw.polygon([(x2, y2), left, right], fill=color)


def dashed(points: list[tuple[float, float]], color: str = ARROW, width: int = 3, dash: int = 10, gap: int = 8) -> None:
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        length = math.hypot(x2 - x1, y2 - y1)
        if length == 0:
            continue
        dx, dy = (x2 - x1) / length, (y2 - y1) / length
        travelled = 0.0
        while travelled < length:
            start = travelled
            end = min(travelled + dash, length)
            draw.line([(x1 + dx * start, y1 + dy * start), (x1 + dx * end, y1 + dy * end)], fill=color, width=width)
            travelled += dash + gap


def arrow(points: list[tuple[float, float]], color: str = ARROW, dashed_line: bool = False) -> None:
    if dashed_line:
        dashed(points, color)
    else:
        draw.line(points, fill=color, width=3, joint="curve")
    arrowhead(points, color)


def label(text: str, x: float, y: float, color: str = ARROW, anchor: str = "mm") -> None:
    width = text_width(text, LABEL)
    if anchor == "mm":
        left = x - width / 2
        top = y - 14
    else:
        left = x
        top = y - 14
    draw.rectangle([left - 6, top, left + width + 6, top + 26], fill=BG)
    draw.text((left, top), text, font=LABEL, fill=color)


# Title
draw.text((230, 34), "DSH 更新后：插件兼容迁移流程", font=TITLE, fill="#10243a")
draw.text((232, 98), "每次官方更新都走这条路径：先体检、再真实回归、最后真机验收；始终从一台测试设备开始，保留旧 tag。", font=SUBTITLE, fill=MUTED)

# Legend
draw.rounded_rectangle([1140, 170, 1780, 480], radius=18, fill="#ffffff", outline="#c9d4e2", width=2)
draw.text((1170, 190), "图例", font=font(24, True), fill=INK)
legend_rows = [
    ("动作", "#ffffff", BLUE),
    ("判断", "#fff8e6", AMBER),
    ("失败修复 / 回退", "#fdecea", RED),
    ("起点 / 完成", "#e8f5e9", GREEN),
]
for index, (name, fill, border) in enumerate(legend_rows):
    y = 238 + index * 48
    draw.rounded_rectangle([1170, y, 1210, y + 26], radius=6, fill=fill, outline=border, width=2)
    draw.text((1226, y - 2), name, font=LEGEND, fill=MUTED)
draw.text((1170, 438), "原则：旧 tag 不删；全绿再推广。", font=SMALL, fill=BLUE)

# Main column geometry
X0, X1, CX = 230, 1010, 620

box(X0, 180, X1, 272, "DSH 官方应用更新完成", "版本可能跨 0.2.x / 0.3.x", "#e8f5e9", GREEN)
box(X0, 320, X1, 445, "先保留回滚点", "• 旧插件 tag 不删除\n• 留一台不自动更新 DSH 的设备")
box(X0, 495, X1, 620, "只在一台测试设备更新 DSH", "• 记录新版本 / app.asar 路径\n• 不要先动全部设备")
box(X0, 670, X1, 795, "静态兼容体检", "• 设置 DSH_ASAR 指向新 app.asar\n• npm run compat")
diamond(CX, 845, 1030, "compat\n全部 PASS？")
box(X0, 1090, X1, 1214, "抽取新版真实依赖", "• npm run vendor -- --force\n• 只更新测试用的 node_modules 副本")
box(X0, 1255, X1, 1380, "真实回归", "• npm run verify\n• 75 项：Host / 探测 / 客户端 / 抓包")
diamond(CX, 1430, 1615, "测试全绿？")
box(X0, 1675, X1, 1828, "真机验收", "• 插件页能打开、保存\n• 真实请求 UA 正确\n• 日志无 UNKNOWN_MODEL / MISSING_CREDENTIAL")
diamond(CX, 1870, 2055, "真机通过？")
box(X0, 2115, X1, 2265, "更新兼容元数据", "• peerDependencies / engines.dsh\n• CHANGELOG / version\n• npm run pack:check")
box(X0, 2300, X1, 2420, "提交并锁定版本", "• git commit + tag vX.Y.Z\n• push 到私有远程")
box(X0, 2470, X1, 2590, "测试设备安装新 tag", "• 再跑一次插件页 + 真实请求")
box(X0, 2640, X1, 2778, "分批推广", "• 先小批量，再全量\n• 保留旧 tag / 旧 DSH 回滚点")
box(X0, 2810, X1, 2905, "完成：插件适配新 DSH", "把 DSH 版本和插件 tag 记录成一对", "#e8f5e9", GREEN)

# Main arrows
for y1, y2 in [
    (272, 320), (445, 495), (620, 670), (795, 845),
    (1030, 1090), (1214, 1255), (1380, 1430),
    (1615, 1675), (1828, 1870), (2055, 2115),
    (2265, 2300), (2420, 2470), (2590, 2640), (2778, 2810),
]:
    arrow([(CX, y1), (CX, y2)])

label("PASS", CX + 42, 1060, GREEN)
label("PASS", CX + 42, 1645, GREEN)
label("PASS", CX + 42, 2085, GREEN)

# Fix boxes
box(1140, 860, 1780, 1035, "按兼容报告修复", "• peer / engine → package.json\n• seam → src/compat.ts → 调用点\n• npm run build 后重跑 compat", "#fdecea", RED)
box(1140, 1450, 1780, 1695, "按失败测试定位", "• adapter-wire → PiAiAdapter / pi-ai\n• registration → llm 注册\n• discovery → 模型探测\n• client-bundle → 槽位 / configForms\n• 修完 rebuild + verify", "#fdecea", RED)
box(1140, 1880, 1780, 2045, "按症状修客户端", "• 插件页/保存 → client.js\n• 凭据/图片 → host.ts\n• rebuild → verify → 再真机", "#fdecea", RED)

# Decision -> fix branches
arrow([(CX + 250, 937), (1140, 937)])
label("FAIL", 1060, 912, RED)
arrow([(CX + 250, 1522), (1140, 1522)])
label("FAIL", 1060, 1497, RED)
arrow([(CX + 250, 1962), (1140, 1962)])
label("FAIL", 1060, 1937, RED)

# Fix -> retry (dashed loops)
arrow([(1140, 985), (1080, 985), (1080, 732), (1010, 732)], dashed_line=True)
label("修复后重跑", 1080, 820, RED, "lm")
arrow([(1140, 1585), (1080, 1585), (1080, 1317), (1010, 1317)], dashed_line=True)
label("修复后重跑", 1080, 1405, RED, "lm")
arrow([(1140, 1995), (1080, 1995), (1080, 1747), (1010, 1747)], dashed_line=True)
label("修复后重跑", 1080, 1815, RED, "lm")

# Major-version note
draw.rounded_rectangle([1140, 2160, 1780, 2450], radius=18, fill="#eef4ff", outline="#4a6fa5", width=2)
draw.text((1170, 2180), "大版本（如 0.3.x）额外一步", font=font(23, True), fill=INK)
for index, line in enumerate([
    "• 从 main 拉 dsh-0.3 分支",
    "• 独立适配、独立 tag / dist-tag",
    "• 设备按 DSH 版本配对安装",
    "• 不与 0.2 设备混用同一个 tag",
]):
    draw.text((1170, 2230 + index * 44), line, font=BODY, fill=MUTED)
draw.text((1170, 2410), "新 DSH 大版本 = 新分支 + 新 tag", font=SMALL, fill=BLUE)

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, "PNG", optimize=True)
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
