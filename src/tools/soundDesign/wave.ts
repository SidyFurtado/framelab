/** WAV decoding and measured alignment, independent of the Premiere host. */
export interface Pcm { rate: number; channels: number; samples: Float32Array }
const fourcc = (view: DataView, at: number): string => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));

export function decodeWav(buffer: ArrayBuffer, maxSeconds = 12): Pcm {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44 || fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "WAVE") throw new Error("Áudio precisa ser convertido para WAV.");
  let format = 0, channels = 0, rate = 0, bits = 0, align = 0, offset = 0, length = 0;
  for (let at = 12; at + 8 <= buffer.byteLength;) {
    const tag = fourcc(view, at), size = view.getUint32(at + 4, true), data = at + 8;
    if (data + size > buffer.byteLength) throw new Error("Arquivo WAV incompleto.");
    if (tag === "fmt " && size >= 16) {
      format = view.getUint16(data, true); channels = view.getUint16(data + 2, true);
      rate = view.getUint32(data + 4, true); align = view.getUint16(data + 12, true); bits = view.getUint16(data + 14, true);
      if (format === 65534 && size >= 40) format = view.getUint16(data + 24, true);
    }
    if (tag === "data") { offset = data; length = size; }
    at = data + size + (size % 2);
  }
  if (![1, 3].includes(format) || ![8, 16, 24, 32].includes(bits) || (format === 3 && bits !== 32) ||
      channels < 1 || channels > 2 || rate < 8000 || rate > 192000 || align !== channels * bits / 8 || !offset || length % align !== 0) {
    throw new Error("Formato WAV precisa de conversão.");
  }
  const count = length / (bits / 8);
  if (count / channels / rate > maxSeconds) throw new Error(`O som tem mais de ${maxSeconds} segundos. Escolha um efeito curto.`);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const at = offset + i * bits / 8;
    let value: number;
    if (format === 3) value = view.getFloat32(at, true);
    else if (bits === 8) value = (view.getUint8(at) - 128) / 128;
    else if (bits === 16) value = view.getInt16(at, true) / 32768;
    else if (bits === 24) {
      let n = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
      if (n & 0x800000) n -= 0x1000000;
      value = n / 8388608;
    } else value = view.getInt32(at, true) / 2147483648;
    if (!Number.isFinite(value)) throw new Error("O WAV contém amostras inválidas.");
    samples[i] = Math.min(1, Math.max(-1, value));
  }
  return { rate, channels, samples };
}

export function encodeWav(pcm: Pcm): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.samples.length * 2), view = new DataView(buffer);
  const tag = (at: number, text: string): void => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  tag(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, pcm.channels, true);
  view.setUint32(24, pcm.rate, true); view.setUint32(28, pcm.rate * pcm.channels * 2, true);
  view.setUint16(32, pcm.channels * 2, true); view.setUint16(34, 16, true); tag(36, "data");
  view.setUint32(40, pcm.samples.length * 2, true);
  for (let i = 0; i < pcm.samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.min(1, Math.max(-1, pcm.samples[i])) * 32767), true);
  return buffer;
}

export function measure(pcm: Pcm): { duration: number; peakSeconds: number; amplitude: number } {
  let maximum = 0, index = 0;
  for (let i = 0; i < pcm.samples.length; i++) {
    const a = Math.abs(pcm.samples[i]);
    if (a > maximum) { maximum = a; index = i; }
  }
  return { duration: pcm.samples.length / pcm.channels / pcm.rate, peakSeconds: Math.floor(index / pcm.channels) / pcm.rate, amplitude: maximum };
}

/** How much of the source to keep around its loudest point, in seconds. */
export interface Shape {
  pre: number;
  post: number;
  /** Used only where the source is cut, never over a natural start or end. */
  fadeIn: number;
  fadeOut: number;
}
export interface Rendered {
  pcm: Pcm;
  /** Sequence seconds, on the frame grid. */
  start: number;
  end: number;
  peak: number;
}

/**
 * Keep a window around the measured transient, fade only where it was cut and normalize to a
 * conservative sample peak. No pitch shifting. Silence pads the start so the transient lands on
 * the exact requested frame, and the end pads to a whole frame.
 */
export function renderSound(pcm: Pcm, peakTime: number, shape: Shape, peakDb: number, frame: number): Rendered {
  if (![peakTime, shape.pre, shape.post, shape.fadeIn, shape.fadeOut, peakDb, frame].every(Number.isFinite) ||
      peakTime < 0 || frame <= 0 || shape.pre < 0 || shape.post <= 0) throw new Error("Ajuste de áudio inválido.");
  const measured = measure(pcm);
  if (measured.amplitude < 0.00001) throw new Error("O arquivo de SFX está silencioso.");
  const { rate, channels } = pcm;
  const length = pcm.samples.length / channels;
  const peakSample = Math.round(measured.peakSeconds * rate);
  const peak = Math.round(peakTime / frame) * frame;
  // At sequence zero, crop pre-roll instead of shifting the transient late.
  const from = Math.max(0, peakSample - Math.round(Math.min(shape.pre, 6) * rate), peakSample - Math.round(peak * rate));
  const to = Math.min(length, Math.max(peakSample + 1, peakSample + Math.round(Math.min(shape.post, 8) * rate)));
  const lead = (peakSample - from) / rate;
  const start = Math.max(0, Math.floor((peak - lead + 1e-9) / frame) * frame);
  const pad = Math.max(0, Math.round((peak - start) * rate) - (peakSample - from));
  const body = pad + to - from;
  const outputFrames = Math.max(body, Math.round(Math.ceil(body / rate / frame - 1e-9) * frame * rate));
  const samples = new Float32Array(outputFrames * channels);
  // Fades stay off the transient: at most 80% of the head, and only after the peak.
  const fadeIn = from > 0 ? Math.min(Math.round(shape.fadeIn * rate), Math.floor((peakSample - from) * 0.8)) : 0;
  const fadeOut = to < length ? Math.max(1, Math.min(Math.round(shape.fadeOut * rate), to - peakSample - 1)) : 0;
  let max = 0;
  for (let f = from; f < to; f++) {
    let envelope = 1;
    if (fadeIn > 0 && f - from < fadeIn) envelope = (f - from + 1) / (fadeIn + 1);
    if (fadeOut > 0 && to - f <= fadeOut) envelope = Math.min(envelope, (to - f - 1) / fadeOut);
    for (let c = 0; c < channels; c++) {
      const value = pcm.samples[f * channels + c] * envelope;
      samples[(pad + f - from) * channels + c] = value;
      max = Math.max(max, Math.abs(value));
    }
  }
  const gain = Math.pow(10, Math.min(-6, Math.max(-36, peakDb)) / 20) / Math.max(0.00001, max);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return { pcm: { rate, channels, samples }, start, end: start + outputFrames / rate, peak };
}

/** Choke a rendered sound at `end` (sequence seconds), fading into the cut. Never cuts the peak. */
export function trimTail(sound: Rendered, end: number, fade: number): Rendered {
  const { rate, channels } = sound.pcm;
  const frames = sound.pcm.samples.length / channels;
  const keep = Math.min(frames, Math.round((end - sound.start) * rate));
  const peakFrame = Math.round((sound.peak - sound.start) * rate);
  if (keep >= frames) return sound;
  if (keep <= peakFrame) throw new Error("Não há espaço para este SFX sem cortar o ataque.");
  const samples = sound.pcm.samples.slice(0, keep * channels);
  const span = Math.max(1, Math.min(Math.round(fade * rate), keep - peakFrame - 1));
  for (let f = keep - span; f < keep; f++) {
    const envelope = (keep - f - 1) / span;
    for (let c = 0; c < channels; c++) samples[f * channels + c] *= envelope;
  }
  return { ...sound, pcm: { rate, channels, samples }, end: sound.start + keep / rate };
}

