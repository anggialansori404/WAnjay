const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");
const pngToIco = require("png-to-ico");

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function createPng(outPngPath) {
  const size = 512; // base design size; we'll downscale to standard ICO sizes
  const bgColor = 0x25d366ff; // WhatsApp-ish green with full alpha

  const img = new Jimp(size, size, bgColor);

  // simple rounded corner mask to feel like an app icon
  const radius = 90;
  const mask = new Jimp(size, size, 0x00000000);
  const white = 0xffffffff;

  // Draw a rounded rectangle mask
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inHoriz = x >= radius && x < size - radius;
      const inVert = y >= radius && y < size - radius;
      const dx1 = x - radius;
      const dy1 = y - radius;
      const dx2 = x - (size - radius - 1);
      const dy2 = y - (size - radius - 1);
      const inTL = dx1 * dx1 + dy1 * dy1 <= radius * radius;
      const inTR = dx2 * dx2 + dy1 * dy1 <= radius * radius;
      const inBL = dx1 * dx1 + dy2 * dy2 <= radius * radius;
      const inBR = dx2 * dx2 + dy2 * dy2 <= radius * radius;
      if (inHoriz || inVert || inTL || inTR || inBL || inBR) {
        mask.setPixelColor(white, x, y);
      }
    }
  }

  img.mask(mask, 0, 0);

  // decide font size based on measured width
  const text = "WAnjay";
  const margin = 32;
  // try large then fallback
  let font = await Jimp.loadFont(Jimp.FONT_SANS_128_WHITE);
  let w = Jimp.measureText(font, text);
  if (w > size - margin * 2) {
    font = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
    w = Jimp.measureText(font, text);
  }

  const h = Jimp.measureTextHeight(font, text, size - margin * 2);
  const x = (size - w) / 2;
  const y = (size - h) / 2;

  // add a subtle drop shadow behind text for contrast
  const shadow = img.clone();
  const shadowFont = font; // same size
  const shadowOffset = 4;
  await shadow.print(shadowFont, x + shadowOffset, y + shadowOffset, {
    text,
    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
    alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE,
  }, w, h);
  shadow.scan(0, 0, size, size, function (sx, sy, idx) {
    const a = this.bitmap.data[idx + 3];
    if (a > 0) {
      // darken pixels a bit
      this.bitmap.data[idx + 0] = Math.max(0, this.bitmap.data[idx + 0] - 40);
      this.bitmap.data[idx + 1] = Math.max(0, this.bitmap.data[idx + 1] - 40);
      this.bitmap.data[idx + 2] = Math.max(0, this.bitmap.data[idx + 2] - 40);
    }
  });

  // blend shadow
  img.composite(shadow, 0, 0, { mode: Jimp.BLEND_DARKEN, opacitySource: 0.5, opacityDest: 1 });

  // draw main text
  await img.print(font, x, y, {
    text,
    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
    alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE,
  }, w, h);

  await img.writeAsync(outPngPath);

  return img;
}

async function createIco(pngPaths, outIcoPath) {
  const icoBuffer = await pngToIco(pngPaths);
  await fs.promises.writeFile(outIcoPath, icoBuffer);
}

async function main() {
  const assetsDir = path.join(__dirname, "..", "assets");
  await ensureDir(assetsDir);

  const pngBasePath = path.join(assetsDir, "wanjay-512.png");
  const icoPath = path.join(assetsDir, "wanjay.ico");

  console.log("Generating PNG icon...");
  const baseImg = await createPng(pngBasePath);

  // Generate standard ICO sizes (max 256)
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngPaths = [];
  for (const s of sizes) {
    const p = path.join(assetsDir, `wanjay-${s}.png`);
    const clone = baseImg.clone().resize(s, s, Jimp.RESIZE_BICUBIC);
    await clone.writeAsync(p);
    pngPaths.push(p);
  }

  console.log("Converting PNG to ICO...");
  await createIco(pngPaths, icoPath);

  console.log("Done:", icoPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
