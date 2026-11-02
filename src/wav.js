// One reader for the PCM WAV clips the call page records (push-to-talk speech, equipment listening).
// It walks the RIFF chunks and returns the format and where the samples start, or null when the file
// is not a PCM WAV. Lengths come from the bytes actually present, never only from the header.

/** { format, channels, rate, bits, byteRate, dataStart, dataBytes } for a RIFF/WAVE buffer, or null. */
export function parseWav(buf) {
  if (
    !Buffer.isBuffer(buf) ||
    buf.length < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null;
  let fmt = null;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= buf.length) {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        rate: buf.readUInt32LE(off + 12),
        byteRate: buf.readUInt32LE(off + 16),
        bits: buf.readUInt16LE(off + 22),
      };
    }
    if (id === 'data') {
      if (!fmt || fmt.format !== 1) return null;
      return { ...fmt, dataStart: off + 8, dataBytes: Math.min(size, buf.length - off - 8) };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Seconds of audio in a PCM WAV; what transcription is billed on. */
export function wavSeconds(buf) {
  const w = parseWav(buf);
  return w && w.byteRate ? w.dataBytes / w.byteRate : null;
}
