// Generate wanjay-unread.ico with red dot overlay using Jimp
const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");
const pngToIco = require("png-to-ico");

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function createUnreadPng(basePngPath, outPngPath) {
  const img = await Jimp.read(basePngPath);
  const size = img.getWidth();
  // Draw red dot in top-right corner
  const dotSize = Math.round(size * 0.22);
  const dot = new Jimp(dotSize, dotSize, 0xff2d2dff); // Red
  dot.circle();
  const margin = Math.round(size * 0.08);
  img.composite(dot, size - dotSize - margin, margin, {
    mode: Jimp.BLEND_SOURCE_OVER,
    opacitySource: 1,
    opacityDest: 1,
  });
  await img.writeAsync(outPngPath);
  return img;
}

async function createIco(pngPaths, outIcoPath) {
  const icoBuffer = await pngToIco(pngPaths);
  await fs.promises.writeFile(outIcoPath, icoBuffer);
}

async function main() {
  // Use src/assets as primary location (relative to project root)
  const assetsDir = path.join(__dirname, "..", "src", "assets");
  await ensureDir(assetsDir);
  const basePngPath = path.join(assetsDir, "wanjay-512.png");
  const unreadPngPath = path.join(assetsDir, "wanjay-unread-512.png");
  const unreadIcoPath = path.join(assetsDir, "wanjay-unread.ico");

  if (!fs.existsSync(basePngPath)) {
    console.error("Base icon PNG not found:", basePngPath);
    process.exit(1);
  }

  console.log("Generating unread PNG icon...");
  const unreadImg = await createUnreadPng(basePngPath, unreadPngPath);

  // Generate standard ICO sizes (max 256)
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngPaths = [];
  for (const s of sizes) {
    const p = path.join(assetsDir, `wanjay-unread-${s}.png`);
    const clone = unreadImg.clone().resize(s, s, Jimp.RESIZE_BICUBIC);
    await clone.writeAsync(p);
    pngPaths.push(p);
  }

  console.log("Converting unread PNGs to ICO...");
  await createIco(pngPaths, unreadIcoPath);
  console.log("Done:", unreadIcoPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
