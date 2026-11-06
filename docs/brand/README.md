# Brand assets

- `logo.svg` — primary logo. 256×256 artboard, rounded dark tile, "PI" monogram in a blue accent with a small cyan signal dot. Scales cleanly from a 16px favicon up to listing hero sizes.

## Exporting to PNG for listings that don't accept SVG

Most directories (mcp.so, PayAPI Market, x402scan, awesome-x402) accept SVG directly, but some third-party platforms want a bitmap. One-line converters:

```bash
# rsvg-convert (part of librsvg; brew install librsvg)
rsvg-convert -w 512 -h 512 docs/brand/logo.svg -o docs/brand/logo-512.png

# ImageMagick
magick convert -background none -resize 512x512 docs/brand/logo.svg docs/brand/logo-512.png

# Inkscape CLI
inkscape --export-type=png --export-width=512 docs/brand/logo.svg
```

Or open `logo.svg` in a browser, right-click the image, and "Save image as…" — Chrome / Safari will render and save as PNG at the current zoom.
