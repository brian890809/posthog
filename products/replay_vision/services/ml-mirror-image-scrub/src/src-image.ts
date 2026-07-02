/** Decode the source image ONCE to raw RGB; every stage re-wraps it instead of re-decoding the PNG.
 *  Decoding a multi-megapixel PNG is tens of ms; the pipeline touches the source 4-5 times. */
import sharp from 'sharp'

export interface Src {
    data: Buffer
    W: number
    H: number
}

export async function decodeSrc(input: Buffer): Promise<Src> {
    const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    return { data, W: info.width, H: info.height }
}

/** A fresh sharp pipeline over the already-decoded raw pixels (no PNG decode). */
export function srcSharp(s: Src): sharp.Sharp {
    return sharp(s.data, { raw: { width: s.W, height: s.H, channels: 3 } })
}
