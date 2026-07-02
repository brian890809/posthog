/**
 * Image scrubbing PoC. Pipelines over the same input so we can compare throughput:
 *  - blurOnly:  the current production baseline (downsample + gaussian blur), ported from
 *               nodejs/.../anonymize/blur.ts so the comparison is apples-to-apples.
 *  - advancedScrub: NSFW/gore gate -> faces blurred -> text regions blurred.
 *
 * NSFW runs on tfjs (native libtensorflow via tfjs-node, else wasm). Face (YuNet) and text (DBNet)
 * run on native onnxruntime-node, async, so they overlap the synchronous NSFW classify. The source
 * is decoded once to raw RGB and shared across stages.
 * import './polyfill.ts' BEFORE this module so tfjs-node loads on Node 23+.
 */
import * as tf from '@tensorflow/tfjs'
import * as nsfw from 'nsfwjs'
import sharp from 'sharp'

import { BLANK_PNG, blurOnly } from './blur.ts'
import { type DbnetModel, detectTextDbnet, loadDbnet } from './dbnet.ts'
import { type Src, decodeSrc, srcSharp } from './src-image.ts'
import { type YunetModel, detectFacesYunet, loadYunet } from './yunet.ts'

export type TextMode = 'heuristic' | 'dbnet'

// blurOnly/BLANK_PNG live in the ML-dep-free blur.ts (what the Stage-1 image ships); re-exported here
// so the eval harness and benchmarks can compare the baseline against advancedScrub from one module.
export { BLANK_PNG, blurOnly }

// --- models -------------------------------------------------------------------------------------
export interface Models {
    nsfw: nsfw.NSFWJS
    dbnet: DbnetModel
    yunet: YunetModel
}

export async function loadModels(
    dbnetPath = 'models/dbnet_det.onnx',
    yunetPath = 'models/yunet.onnx'
): Promise<Models> {
    // Prefer native libtensorflow (tfjs-node) for NSFW; fall back to wasm if it can't load.
    try {
        await import('@tensorflow/tfjs-node') // side effect: registers the 'tensorflow' backend
        await tf.setBackend('tensorflow')
        await tf.ready()
    } catch (e) {
        console.warn('tfjs-node (native) failed, falling back to wasm:', String(e))
        const { setWasmPaths } = await import('@tensorflow/tfjs-backend-wasm')
        setWasmPaths('node_modules/@tensorflow/tfjs-backend-wasm/dist/')
        await tf.setBackend('wasm')
        await tf.ready()
    }
    console.error(`  tfjs backend: ${tf.getBackend()}`)

    const [nsfwModel, dbnet, yunet] = await Promise.all([
        nsfw.load(), // default MobileNetV2 224 model, fetched + cached
        loadDbnet(dbnetPath),
        loadYunet(yunetPath),
    ])
    return { nsfw: nsfwModel, dbnet, yunet }
}

export async function disposeModels(_m: Models): Promise<void> {
    // nothing to tear down
}

// --- advanced pipeline --------------------------------------------------------------------------
export interface StageTimings {
    decodeMs: number
    nsfwMs: number
    faceMs: number
    textMs: number
    composeMs: number
    encodeMs: number
    totalMs: number
    blanked: boolean
    faces: number
    textBoxes: number
}

const NSFW_THRESHOLD = 0.6 // Porn/Hentai/Sexy combined; deliberately loose, this is a safety net
const PNG_LEVEL = Number(process.env.PNG_LEVEL ?? 3) // sharp png compressionLevel; lower = faster, bigger
const PIXELATE_ENV = process.env.PIXELATE ? Number(process.env.PIXELATE) : null
// Text gets a SOLID mean-colour fill (irreversible) rather than a blur/mosaic (a low-pass filter that
// leaves coarse structure an LLM can still read). Margin scales with box height — our horizontal-only
// dilation makes each box one line, so its height is a font-size proxy — so big titles get a big
// margin. Edges are feathered so the fill isn't a jarring hard rectangle.
const TEXT_MARGIN_FRAC = Number(process.env.TEXT_MARGIN_FRAC ?? 0.25) // top/side margin as a fraction of box height
const TEXT_MARGIN_BOTTOM_FRAC = Number(process.env.TEXT_MARGIN_BOTTOM_FRAC ?? 0.45) // extra below for descenders
const TEXT_MARGIN_MIN = Number(process.env.TEXT_MARGIN_MIN ?? 4) // floor in px for tiny text
const EDGE_BLUR = Number(process.env.EDGE_BLUR ?? 4) // sigma to feather redaction-region edges

/** Mosaic block size (~px). Scales with resolution so retina text is destroyed, not just softened,
 *  while small images aren't over-blocked. Re-detection by the verifier confirms it's strong enough. */
function pixelateBlock(W: number, H: number): number {
    return PIXELATE_ENV ?? Math.max(10, Math.min(24, Math.round(Math.max(W, H) / 170)))
}

interface Box {
    left: number
    top: number
    width: number
    height: number
}

function clampBox(b: Box, W: number, H: number): Box | null {
    const left = Math.max(0, Math.min(W - 1, Math.round(b.left)))
    const top = Math.max(0, Math.min(H - 1, Math.round(b.top)))
    const width = Math.max(1, Math.min(W - left, Math.round(b.width)))
    const height = Math.max(1, Math.min(H - top, Math.round(b.height)))
    if (width < 2 || height < 2) {
        return null
    }
    return { left, top, width, height }
}

// --- input preparation --------------------------------------------------------------------------
const NSFW_SIZE = 224 // nsfwjs resizes to this internally; feed it pre-shrunk so the resize is cheap

/** Adaptive DBNet input resolution: big enough to resolve small text on retina shots, capped for cost. */
// Detection input resolution as a fraction of the image's long side. 0.75 clears all crisp rendered
// UI (session replay's actual domain) cheaply; raise toward 1.0 for faint/small scanned-document
// print (more CPU), lower for more throughput. Faint low-contrast text is contrast- not size-limited,
// so resolution alone won't catch every faded fax line.
const DET_FACTOR = Number(process.env.DET_FACTOR ?? 0.75)
const DET_CAP = Number(process.env.DET_CAP ?? 1600) // cap so retina screenshots don't explode
function adaptiveDetLimit(W: number, H: number): number {
    const target = Math.round((Math.max(W, H) * DET_FACTOR) / 32) * 32
    return Math.max(736, Math.min(DET_CAP, target))
}

async function nsfwTensor(src: Src): Promise<tf.Tensor3D> {
    const { data } = await srcSharp(src)
        .resize(NSFW_SIZE, NSFW_SIZE, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true })
    return tf.tensor3d(new Uint8Array(data), [NSFW_SIZE, NSFW_SIZE, 3], 'int32')
}

/** Whole worker job for one image, advanced path. Detection is parallelized: DBNet runs on
 *  onnxruntime's background thread (async) while NSFW + face run on tfjs (synchronous), so the
 *  text-detection latency is hidden behind the tfjs compute. */
export async function advancedScrub(
    input: Buffer,
    m: Models,
    textMode: TextMode = 'dbnet'
): Promise<{ out: Buffer; t: StageTimings }> {
    const timings: StageTimings = {
        decodeMs: 0,
        nsfwMs: 0,
        faceMs: 0,
        textMs: 0,
        composeMs: 0,
        encodeMs: 0,
        totalMs: 0,
        blanked: false,
        faces: 0,
        textBoxes: 0,
    }
    const t0 = performance.now()
    const tDec = performance.now()
    const src = await decodeSrc(input) // decode the PNG ONCE; every stage re-wraps these raw pixels
    const { W, H } = src
    timings.decodeMs = performance.now() - tDec

    // 1. NSFW / gore gate FIRST: if it trips we skip all detection. Running it first (rather than
    //    overlapping detection) keeps each worker ~1 core, which packs better under multi-process
    //    scaling — the throughput-bound case. Set PARALLEL_DETECT=1 to overlap instead (lower latency
    //    per image, but each worker uses more cores).
    const tN = performance.now()
    const nt = await nsfwTensor(src)
    let bad = 0
    try {
        const preds = await m.nsfw.classify(nt as unknown as tf.Tensor3D)
        bad = preds
            .filter((p) => p.className === 'Porn' || p.className === 'Hentai' || p.className === 'Sexy')
            .reduce((s, p) => s + p.probability, 0)
    } finally {
        nt.dispose()
    }
    timings.nsfwMs = performance.now() - tN
    if (bad >= NSFW_THRESHOLD) {
        timings.blanked = true
        timings.totalMs = performance.now() - t0
        return { out: BLANK_PNG, t: timings }
    }

    // 2. Face (YuNet) + text (DBNet), both native ORT. Serial by default (1 core/worker); parallel opt-in.
    const det = adaptiveDetLimit(W, H)
    const runText = (): Promise<Box[]> =>
        textMode === 'dbnet' ? detectTextDbnet(m.dbnet, src, W, H, { detLimit: det }) : detectTextRegions(input, W, H)
    let faceBoxes: Box[]
    let textBoxes: Box[]
    if (process.env.PARALLEL_DETECT === '1') {
        const tD = performance.now()
        ;[faceBoxes, textBoxes] = await Promise.all([detectFacesYunet(m.yunet, src, W, H), runText()])
        timings.faceMs = timings.textMs = performance.now() - tD
    } else {
        const tF = performance.now()
        faceBoxes = await detectFacesYunet(m.yunet, src, W, H)
        timings.faceMs = performance.now() - tF
        const tT = performance.now()
        textBoxes = await runText()
        timings.textMs = performance.now() - tT
    }
    timings.faces = faceBoxes.length
    timings.textBoxes = textBoxes.length

    const out = await compose(src, W, H, faceBoxes, textBoxes, timings)
    timings.totalMs = performance.now() - t0
    return { out, t: timings }
}

/**
 * Model-free text detector. Text has high local edge density, so: downscale to grayscale, compute
 * a gradient map, tile it, and mark tiles whose mean gradient is high (but not saturated, which
 * filters out hard image/photo edges). Returns the texty tiles as boxes in full-res coords. Rough,
 * but we only need "blur where text is", not character-accurate boxes.
 */
const TEXT_DS_WIDTH = 480 // downscale width for the gradient pass
const TEXT_TILE = 10 // tile size in downscaled px
const TEXT_EDGE_T = 22 // mean gradient threshold for a tile to count as text

async function detectTextRegions(input: Buffer, W: number, H: number): Promise<Box[]> {
    const dsW = Math.min(W, TEXT_DS_WIDTH)
    const sx = W / dsW
    const dsH = Math.max(1, Math.round(H / sx))
    const { data, info } = await sharp(input)
        .grayscale()
        .resize(dsW, dsH, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true })
    const w = info.width
    const h = info.height
    const cols = Math.ceil(w / TEXT_TILE)
    const rows = Math.ceil(h / TEXT_TILE)
    const sum = new Float64Array(cols * rows)
    const cnt = new Int32Array(cols * rows)
    const sat = new Int32Array(cols * rows) // count of very-strong edges (likely photo/icon, not text)

    for (let y = 1; y < h - 1; y++) {
        const row = y * w
        for (let x = 1; x < w - 1; x++) {
            const i = row + x
            const g = Math.abs(data[i + 1] - data[i - 1]) + Math.abs(data[i + w] - data[i - w])
            const ci = Math.floor(y / TEXT_TILE) * cols + Math.floor(x / TEXT_TILE)
            sum[ci] += g
            cnt[ci]++
            if (g > 200) {
                sat[ci]++
            }
        }
    }

    const boxes: Box[] = []
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const ci = r * cols + c
            const n = cnt[ci]
            if (n === 0) {
                continue
            }
            const mean = sum[ci] / n
            const satFrac = sat[ci] / n
            if (mean > TEXT_EDGE_T && satFrac < 0.12) {
                const b = clampBox(
                    {
                        left: c * TEXT_TILE * sx,
                        top: r * TEXT_TILE * sx,
                        width: TEXT_TILE * sx,
                        height: TEXT_TILE * sx,
                    },
                    W,
                    H
                )
                if (b) {
                    boxes.push(b)
                }
            }
        }
    }
    return boxes
}

/** Blur the union of face + text regions back onto the base image. Box-count-independent: blur the
 *  whole frame once, keep only the masked regions (dest-in), composite back over the original. */
async function compose(
    src: Src,
    W: number,
    H: number,
    faceBoxes: Box[],
    textBoxes: Box[],
    timings: StageTimings
): Promise<Buffer> {
    const tC = performance.now()
    const allBoxes = [...faceBoxes, ...textBoxes]
    if (allBoxes.length === 0) {
        timings.composeMs = performance.now() - tC
        const tE0 = performance.now()
        const out0 = await srcSharp(src).png({ compressionLevel: PNG_LEVEL }).toBuffer()
        timings.encodeMs = performance.now() - tE0
        return out0
    }

    // Faces: mosaic (keeps the "a person is here" context while hiding identity). Built once as a
    // full-frame downscale -> nearest upscale; we copy only the face regions out of it.
    // NOTE: sharp does ONE resize per pipeline, so down- and up-scale are two separate pipelines.
    const block = pixelateBlock(W, H)
    const pw = Math.max(1, Math.round(W / block))
    const ph = Math.max(1, Math.round(H / block))
    const small = await srcSharp(src).resize(pw, ph, { fit: 'fill' }).raw().toBuffer()
    const mosaic = await sharp(small, { raw: { width: pw, height: ph, channels: 3 } })
        .resize(W, H, { fit: 'fill', kernel: 'nearest' })
        .raw()
        .toBuffer()

    // Redaction layer starts as a copy of the source; we OVERWRITE regions rather than low-pass
    // filter them, so text is destroyed (irreversible) not merely softened. Text and faces get
    // SEPARATE masks because they composite differently (faces must NOT be blurred — see below).
    const red = Buffer.from(src.data)
    const alphaText = new Uint8Array(W * H)
    const alphaFace = new Uint8Array(W * H)

    for (const b of faceBoxes) {
        for (let y = b.top; y < b.top + b.height; y++) {
            const o = (y * W + b.left) * 3
            mosaic.copy(red, o, o, o + b.width * 3)
            alphaFace.fill(255, y * W + b.left, y * W + b.left + b.width)
        }
    }

    // Text: fill each box with its mean colour, plus a margin scaled to box height (= font size). The
    // bottom margin is larger because DBNet boxes sit on the baseline, so descenders (g, y, p, q, j)
    // hang below the box and need extra coverage. A uniform fill leaves no glyph structure.
    for (const t of textBoxes) {
        const m = Math.round(Math.max(TEXT_MARGIN_MIN, t.height * TEXT_MARGIN_FRAC))
        const mb = Math.round(Math.max(TEXT_MARGIN_MIN, t.height * TEXT_MARGIN_BOTTOM_FRAC))
        const b = clampBox(
            { left: t.left - m, top: t.top - m, width: t.width + 2 * m, height: t.height + m + mb },
            W,
            H
        )
        if (!b) {
            continue
        }
        let r = 0,
            g = 0,
            bl = 0
        const n = b.width * b.height
        for (let y = b.top; y < b.top + b.height; y++) {
            let idx = (y * W + b.left) * 3
            for (let x = 0; x < b.width; x++, idx += 3) {
                r += src.data[idx]
                g += src.data[idx + 1]
                bl += src.data[idx + 2]
            }
        }
        // Quantize the fill to the top 4 bits per channel (16 levels each, 12 bits total instead of
        // 24) so it carries even less signal about the underlying text/background colours.
        r = Math.round(r / n) & 0xf0
        g = Math.round(g / n) & 0xf0
        bl = Math.round(bl / n) & 0xf0
        for (let y = b.top; y < b.top + b.height; y++) {
            let idx = (y * W + b.left) * 3
            for (let x = 0; x < b.width; x++, idx += 3) {
                red[idx] = r
                red[idx + 1] = g
                red[idx + 2] = bl
            }
            alphaText.fill(255, y * W + b.left, y * W + b.left + b.width)
        }
    }

    const textLayer = Buffer.from(alphaText.buffer, alphaText.byteOffset, alphaText.byteLength)
    const faceLayer = Buffer.from(alphaFace.buffer, alphaFace.byteOffset, alphaFace.byteLength)
    const raw3 = { raw: { width: W, height: H, channels: 3 } } as const
    const raw1 = { raw: { width: W, height: H, channels: 1 } } as const

    // Text: solid bars whose edges are softened by blurring the COLOUR layer (alpha stays hard, so no
    // original text is ever revealed; the blur only fades the fill into its background margin).
    const redBlurred = EDGE_BLUR > 0 ? await sharp(red, raw3).blur(EDGE_BLUR).raw().toBuffer() : red
    const composites: sharp.OverlayOptions[] = [
        { input: await sharp(redBlurred, raw3).joinChannel(textLayer, raw1).png().toBuffer(), left: 0, top: 0 },
    ]
    // Faces: composite the CRISP (unblurred) mosaic. Blurring a mosaic re-smooths it into a face a
    // detector can find again, so the face layer must skip the edge blur the text layer uses.
    if (faceBoxes.length > 0) {
        composites.push({
            input: await sharp(red, raw3).joinChannel(faceLayer, raw1).png().toBuffer(),
            left: 0,
            top: 0,
        })
    }

    timings.composeMs = performance.now() - tC
    const tE = performance.now()
    const out = await srcSharp(src).composite(composites).png({ compressionLevel: PNG_LEVEL }).toBuffer()
    timings.encodeMs = performance.now() - tE
    return out
}
