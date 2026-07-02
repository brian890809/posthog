import { existsSync } from 'node:fs'
/**
 * One-time setup: download the ONNX models and a bounded sample of real test images (faces + text),
 * then generate the synthetic corpus. Nothing here is committed (see .gitignore) — rerun any time.
 *
 *   npm run setup
 *
 * Test images come from the HuggingFace datasets-server REST API (no Python / `datasets` needed):
 * /splits discovers a valid config+split, /rows returns rows whose image cells carry a `src` URL.
 * The dataset list below is just defaults — swap in whatever faces/text sources you want.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const ROOT = new URL('..', import.meta.url).pathname
const TLS = { rejectUnauthorized: false } as const // this env serves an incomplete cert chain; PoC only
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const MODELS: { url: string; file: string }[] = [
    {
        url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/en_PP-OCRv3_det_infer.onnx',
        file: 'models/dbnet_det.onnx',
    },
    {
        url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
        file: 'models/yunet.onnx',
    },
]

// HuggingFace datasets to sample (verified reachable via datasets-server). Faces: real faces. Text:
// dense text + PII-like fields. Swap in others (RICO/WebUI screenshots, COCO-Text/ICDAR scene text).
// Verified: /rows returns an image whose asset URL actually fetches (some datasets' presigned
// cached-asset URLs 403, e.g. flwrlabs/celeba — avoid those).
const DATASETS: { dataset: string; dir: string; count: number }[] = [
    { dataset: 'tonyassi/celebrity-1000', dir: 'test-data/faces', count: 50 }, // real celebrity faces
    { dataset: 'logasja/lfw', dir: 'test-data/faces', count: 30 }, // Labeled Faces in the Wild
    { dataset: 'nielsr/funsd', dir: 'test-data/text', count: 20 }, // forms — dense text + PII-like fields
]

const UA = 'Mozilla/5.0 posthog-replay-image-scrub' // HF + most CDNs reject requests without one

async function get(url: string): Promise<Response> {
    return fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'user-agent': UA }, ...(TLS as object) })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** GET JSON with retries; the datasets-server intermittently returns HTML error pages on flaky links. */
async function getJson(url: string, tries = 3): Promise<any> {
    for (let i = 0; i < tries; i++) {
        try {
            const text = await (await get(url)).text()
            return JSON.parse(text) // throws on an HTML error page -> retry
        } catch (e) {
            if (i === tries - 1) {
                throw e
            }
            await sleep(1000 * (i + 1))
        }
    }
}

async function getBuf(url: string, tries = 3): Promise<Buffer> {
    for (let i = 0; i < tries; i++) {
        try {
            const res = await get(url)
            if (!res.ok) {
                throw new Error(`status ${res.status}`)
            }
            return Buffer.from(await res.arrayBuffer())
        } catch (e) {
            if (i === tries - 1) {
                throw e
            }
            await sleep(1000 * (i + 1))
        }
    }
    throw new Error('unreachable')
}

async function downloadModels(): Promise<void> {
    for (const m of MODELS) {
        const dest = ROOT + m.file
        if (existsSync(dest)) {
            continue
        }
        await mkdir(ROOT + 'models', { recursive: true })
        await writeFile(dest, await getBuf(m.url))
    }
}

/** Find the first column in a datasets-server row whose value looks like an image ({ src }). */
function imageUrlOf(row: Record<string, unknown>): string | null {
    for (const v of Object.values(row)) {
        if (v && typeof v === 'object' && typeof (v as { src?: unknown }).src === 'string') {
            return (v as { src: string }).src
        }
    }
    return null
}

async function downloadHf(dataset: string, dir: string, count: number): Promise<number> {
    const splits = await getJson(`https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(dataset)}`)
    const list: { config: string; split: string }[] = splits?.splits ?? []
    if (!list.length) {
        throw new Error(`no splits for ${dataset}`)
    }
    const pick = list.find((s) => /val|test/.test(s.split)) ?? list[0]
    const data = await getJson(
        `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(pick.config)}&split=${encodeURIComponent(pick.split)}&offset=0&length=${count}`
    )
    const rows = data?.rows ?? []
    await mkdir(ROOT + dir, { recursive: true })
    let n = 0
    for (const r of rows) {
        const url = imageUrlOf(r.row ?? {})
        if (!url) {
            continue
        }
        try {
            await sharp(await getBuf(url))
                .png()
                .toFile(`${ROOT}${dir}/${dataset.replace(/\W+/g, '_')}_${n}.png`)
            n++
        } catch {
            // skip a bad row
        }
    }
    return n
}

async function main(): Promise<void> {
    await downloadModels()

    let total = 0
    for (const d of DATASETS) {
        try {
            const n = await downloadHf(d.dataset, d.dir, d.count)
            total += n
        } catch (e) {
            console.warn(`  ${d.dataset}: failed (${String(e)})`)
        }
    }
    if (total === 0) {
        console.warn('no HF images fetched (network?); the suite will still run on the synthetic corpus')
    }

    await import('./make-corpus.ts')
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
