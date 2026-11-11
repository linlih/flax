# Flax 品牌资源

图标：折纸 F（全蓝·冷调）。一条纸带折成 F：竖笔是纸的正面，横笔是翻过来的背面，折痕为 45°。

## 颜色

| 用途 | 色值 |
|---|---|
| 底色渐变（左上 → 右下） | `#6F82F6` → `#3343C4` |
| 纸正面 | `#FFFFFF` → `#EEF1FF` |
| 纸背面 | `#C3CDFF` → `#A3B1FF` |
| 浅底上的标记：正面 / 背面 | `#7D8FF7`→`#5163E4` / `#2F3C96`→`#212B72` |

## 文件

- `svg/flax-icon.svg`：圆角方形图标，通用源文件
- `svg/flax-icon-ios.svg`、`ios/AppIcon-1024.png`：iOS / iPadOS，满版方形无透明（系统自动裁圆角）
- `svg/flax-icon-android-{fg,bg}.svg`、`android/adaptive-{fg,bg}-1024.png`：Android 自适应图标的两层（108dp 画布，F 缩到 0.72 落在中间 66dp 的安全圆里；底是渐变）
- `svg/flax-icon-macos.svg`、`macos/icon-1024.png`、`macos/Flax.icns`：macOS，按 824/1024 网格留边并带投影
- `svg/flax-mark-on-dark.svg`、`svg/flax-mark-on-light.svg`：只有 F 的标记，透明背景
- `svg/flax-lockup.svg`、`png/flax-lockup-1128.png`：横版图标 + 字标
- `png/flax-icon-{16…1024}.png`：各尺寸 PNG
- `web/`：`favicon.svg`、`favicon.ico`（16/32/48）、`apple-touch-icon.png`、`icon-192.png`、`icon-512.png`

## 待办

- 字标暂用 Bricolage Grotesque Bold（SVG 引用 Google Fonts，PNG 渲染时回退成了 Helvetica Bold）。定稿后应转为轮廓路径。
