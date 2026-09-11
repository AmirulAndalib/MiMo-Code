import { describe, expect, test } from "bun:test"
import {
  base64Length,
  fitsMediaBase64,
  isMedia,
  MAX_MEDIA_BASE64_BYTES,
  sniffAttachmentMime,
} from "../../src/util/media"

describe("util.media", () => {
  test("bounds inline audio/video on the encoded size", () => {
    // 3 raw bytes encode to 4; the last byte under the limit is 3/4 of it.
    const raw = (MAX_MEDIA_BASE64_BYTES / 4) * 3
    expect(base64Length(raw)).toBe(MAX_MEDIA_BASE64_BYTES)
    expect(fitsMediaBase64(raw)).toBe(true)
    expect(fitsMediaBase64(raw + 1)).toBe(false)
    expect(base64Length(Buffer.from("hello").byteLength)).toBe(Buffer.from("hello").toString("base64").length)
  })

  test("treats audio and video as media", () => {
    expect(isMedia("audio/wav")).toBe(true)
    expect(isMedia("video/mp4")).toBe(true)
    expect(isMedia("image/png")).toBe(true)
    expect(isMedia("text/plain")).toBe(false)
  })

  test("sniffs a RIFF/WAVE header as audio/wav", () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])
    expect(sniffAttachmentMime(wav, "application/octet-stream")).toBe("audio/wav")
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])
    expect(sniffAttachmentMime(webp, "application/octet-stream")).toBe("image/webp")
  })
})
