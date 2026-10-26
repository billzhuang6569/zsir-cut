# Synthetic fixture tools

Generation is macOS-only. It uses Node.js 24, Swift 6.3 with AppKit/CoreGraphics, and local FFmpeg/FFprobe 8.1.x (tested with FFmpeg 8.1.1). No software is installed by the generator. The Swift source is interpreted for each generation; its module cache and rendered RGBA labels are temporary files under `fixtures/.media/.tmp/`.

Text uses the macOS system font **Hiragino Sans GB**, PostScript name `HiraginoSansGB-W3`, at `/System/Library/Fonts/Hiragino Sans GB.ttc`. Swift renders only text labels. Node composes the labels with its deterministic pixels for the white frames and machine barcode; FFmpeg encodes video and wraps PCM audio. On the same machine and input, the rendered pixels are identical.

| Command | Purpose |
|---|---|
| `pnpm fixtures:gen` | Generate all ten media files and `fingerprints.json` under `fixtures/.media/`. |
| `pnpm fixtures:check` | Probe every file, decode sampled frame barcodes, and check metadata and pulse placement. Requires FFmpeg/FFprobe. |
| `pnpm fixtures:bind` | Copy the three template projects under `.media/projects/` with actual paths, sizes, and fingerprints. |
| `pnpm fixtures:relocate <new root directory>` | Move the entire `.media` directory for relinking tests. The destination must not exist. |

The Vitest tests use only Node and installed project dependencies. CI does not need Swift or FFmpeg.
