// Turns raw simulator screenshots into Zepp Store preview images
// (https://docs.zepp.com/docs/distribute/): 360x360 transparent PNGs.
//   round  -> the screenshot fills the square, cropped to the watch's circle, no margin
//   square -> the screenshot fills the height, centred, equal margins left and right
// Usage: node scripts/make-previews.js   (reads previews/raw/{round,square}-*.png)
import { readdir, mkdir } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const RAW_DIR = 'previews/raw'
const OUT_DIR = 'previews/out'
const SIZE = 360

async function round(input) {
  const circle = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}"><circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2}"/></svg>`
  )
  return sharp(input)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .ensureAlpha()
    .composite([{ input: circle, blend: 'dest-in' }])
    .png()
    .toBuffer()
}

async function square(input) {
  const shot = await sharp(input).resize({ height: SIZE, fit: 'inside' }).ensureAlpha().png().toBuffer()
  const { width } = await sharp(shot).metadata()
  return sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: shot, left: Math.round((SIZE - width) / 2), top: 0 }])
    .png()
    .toBuffer()
}

await mkdir(OUT_DIR, { recursive: true })
const files = (await readdir(RAW_DIR)).filter((f) => /^(round|square)-.*\.png$/i.test(f))
if (files.length === 0) {
  console.error(`No ${RAW_DIR}/round-*.png or square-*.png found.`)
  process.exit(1)
}
for (const file of files.sort()) {
  const input = path.join(RAW_DIR, file)
  const out = file.startsWith('round') ? await round(input) : await square(input)
  await sharp(out).toFile(path.join(OUT_DIR, file))
  console.log(`${file} -> ${OUT_DIR}/${file}`)
}
