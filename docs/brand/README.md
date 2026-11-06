# Brand assets

- `logo.svg` — primary logo. Full-bleed dark fill (edge-to-edge, no inner rounded corners so listing containers can clip without a visible inner tile), "PI" monogram in a blue accent with a small cyan signal dot. 256-unit viewBox at 1024×1024 natural render size. Works as a 16px favicon through a listing hero.
- `logo.png` — 1024×1024 bitmap generated from `logo.svg`. mcp.so (and some other listings) reject SVG uploads and want PNG; this is the canonical asset for those.

## Regenerating the PNG

Use whichever converter is on hand. The known-working recipe on macOS with no extra install:

```bash
# macOS built-in (Quick Look). -s is the OUTPUT size in pixels;
# the SVG's own width/height tell the renderer at what resolution to rasterize,
# which is why logo.svg declares width="1024" height="1024" with a 256 viewBox.
qlmanage -t -s 1024 -o docs/brand/ docs/brand/logo.svg \
  && mv docs/brand/logo.svg.png docs/brand/logo.png
```

Other converters if installed:

```bash
# rsvg-convert (brew install librsvg)
rsvg-convert -w 1024 -h 1024 docs/brand/logo.svg -o docs/brand/logo.png

# ImageMagick
magick -background none -resize 1024x1024 docs/brand/logo.svg docs/brand/logo.png

# Inkscape CLI
inkscape --export-type=png --export-width=1024 docs/brand/logo.svg
```

If an output PNG shows white padding in any corner after `qlmanage`, the SVG's `width`/`height` attrs are smaller than `-s`; raise them to match.

## Where it's live

- mcp.so avatar — uploaded 2026-11-06 (PNG).
- PayAPI Market — pending email to Chet Parker with the PNG attached.
- x402scan — no user-editable logo field.
