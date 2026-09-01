/**
 * Corte de Silêncios — detecção pela onda.
 *
 * O ffmpeg entrega PCM cru (mono, 8 kHz, 16 bits, já passado por um
 * high-pass) e daqui para a frente é tudo JS puro: RMS por janela de
 * 20 ms vira uma curva em dBFS, e é essa curva que responde "aqui tem
 * fala?". Guardar a CURVA — e não os samples — é o que deixa o limiar
 * ser um slider de verdade: mexer nele recalcula o plano inteiro sem
 * reler disco nem chamar o ffmpeg de novo. Dez minutos de áudio cabem
 * em 30 mil floats.
 *
 * 8 kHz não é economia à toa: a energia da fala vive abaixo de 4 kHz,
 * que é exatamente o que essa taxa carrega. O high-pass em 85 Hz tira
 * ronco de ar-condicionado e trepidação de mesa, que sobem o RMS sem
 * ser som nenhum — é a diferença entre um piso de ruído honesto e um
 * piso inflado por grave inaudível.
 */
import type { VoicedSpan } from "./detect";

export const PCM_SAMPLE_RATE = 8000;
export const PCM_WINDOW_SECONDS = 0.02;
/** Piso do dBFS: silêncio digital vira isto em vez de -Infinity. */
export const DB_FLOOR = -120;

export interface Envelope {
  /** dBFS por janela, em ordem. */
  db: Float32Array;
  windowSeconds: number;
  /** Tempo de mídia da primeira janela. */
  offsetSeconds: number;
  /** Piso de ruído estimado, em dBFS. */
  noiseFloorDb: number;
  /** Nível dos trechos altos, em dBFS. Percentil 95. */
  loudDb: number;
  /** Pico absoluto, em dBFS. */
  peakDb: number;
}

/**
 * Constrói a curva conforme o PCM chega.
 *
 * Recebe pedaços porque o arquivo é lido em blocos: um take longo não
 * precisa caber inteiro na memória, e só a curva sobrevive à leitura.
 * O `carry` existe porque um sample de 16 bits pode ficar partido
 * entre dois blocos — sem ele, um byte órfão desalinharia todo o
 * resto do arquivo.
 */
export class EnvelopeBuilder {
  private readonly samplesPerWindow: number;
  private readonly values: number[] = [];
  private sumSquares = 0;
  private count = 0;
  private carry = -1;

  constructor(
    sampleRate: number = PCM_SAMPLE_RATE,
    private readonly windowSeconds: number = PCM_WINDOW_SECONDS,
    private readonly offsetSeconds: number = 0
  ) {
    this.samplesPerWindow = Math.max(
      1,
      Math.round(sampleRate * windowSeconds)
    );
  }

  push(buffer: ArrayBuffer, byteLength: number): void {
    const bytes = new Uint8Array(buffer, 0, byteLength);
    let index = 0;

    if (this.carry >= 0 && bytes.length > 0) {
      this.addSample(toSigned16(this.carry | (bytes[0] << 8)));
      this.carry = -1;
      index = 1;
    }

    for (; index + 1 < bytes.length; index += 2) {
      this.addSample(toSigned16(bytes[index] | (bytes[index + 1] << 8)));
    }
    if (index < bytes.length) {
      this.carry = bytes[index];
    }
  }

  finish(): Envelope {
    if (this.count > 0) {
      this.closeWindow();
    }
    const db = Float32Array.from(this.values);
    return {
      db,
      windowSeconds: this.windowSeconds,
      offsetSeconds: this.offsetSeconds,
      ...measureLevels(db),
    };
  }

  private addSample(sample: number): void {
    const normalized = sample / 32768;
    this.sumSquares += normalized * normalized;
    this.count += 1;
    if (this.count >= this.samplesPerWindow) {
      this.closeWindow();
    }
  }

  private closeWindow(): void {
    const rms = Math.sqrt(this.sumSquares / this.count);
    this.values.push(rms > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(rms)) : DB_FLOOR);
    this.sumSquares = 0;
    this.count = 0;
  }
}

function toSigned16(value: number): number {
  return value >= 0x8000 ? value - 0x10000 : value;
}

/**
 * Piso de ruído e nível de fala.
 *
 * O piso sai do percentil 10 — o que sobra quando ninguém fala. Duas
 * correções importam: janelas em silêncio digital são deixadas de
 * fora (um trecho mudo de verdade puxaria o piso para -120 e faria o
 * chiado do resto virar "fala"), e o resultado nunca passa de 10 dB
 * abaixo do nível alto, para um clipe que é só fala não estimar um
 * piso em cima da própria voz.
 */
function measureLevels(db: Float32Array): {
  noiseFloorDb: number;
  loudDb: number;
  peakDb: number;
} {
  if (db.length === 0) {
    return { noiseFloorDb: DB_FLOOR, loudDb: DB_FLOOR, peakDb: DB_FLOOR };
  }

  let peakDb = DB_FLOOR;
  const audible: number[] = [];
  for (const value of db) {
    if (value > peakDb) {
      peakDb = value;
    }
    if (value > DB_FLOOR + 20) {
      audible.push(value);
    }
  }

  const pool = audible.length >= Math.max(8, db.length * 0.05) ? audible : Array.from(db);
  pool.sort((a, b) => a - b);

  const loudDb = percentile(pool, 0.95);
  const rawFloor = percentile(pool, 0.1);
  return {
    noiseFloorDb: Math.min(rawFloor, loudDb - 10),
    loudDb,
    peakDb,
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) {
    return DB_FLOOR;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * ratio))
  );
  return sorted[index];
}

export interface ThresholdChoice {
  /** Limiar usado, em dBFS. */
  db: number;
  /** true quando saiu do piso de ruído medido. */
  automatic: boolean;
}

/**
 * O limiar que separa fala de silêncio.
 *
 * No automático ele é o piso de ruído medido mais uma margem — é o que
 * faz um take com ar-condicionado se calibrar sozinho, em vez de o
 * editor caçar um número absoluto que muda a cada gravação. O teto
 * existe como rede: um limiar acima do nível da própria fala apagaria
 * o clipe inteiro, e nenhuma margem deve conseguir chegar lá.
 */
export function resolveThreshold(
  envelope: Envelope,
  autoThreshold: boolean,
  marginDb: number,
  manualDb: number
): ThresholdChoice {
  if (!autoThreshold) {
    return { db: manualDb, automatic: false };
  }
  const ceiling = Math.max(
    envelope.noiseFloorDb + 3,
    envelope.loudDb - 10
  );
  return {
    db: Math.min(envelope.noiseFloorDb + marginDb, ceiling),
    automatic: true,
  };
}

/** Histerese: sai da fala 2 dB abaixo de onde entrou. */
const HYSTERESIS_DB = 2;

/**
 * A curva vira intervalos de fala.
 *
 * Entra em fala ao cruzar o limiar e só sai 2 dB abaixo dele. Sem essa
 * histerese, uma sílaba que oscila em volta do limiar viraria dezenas
 * de intervalos picados, e cada respiração no limite abriria um corte
 * de um frame.
 */
export function spansFromEnvelope(
  envelope: Envelope,
  thresholdDb: number
): VoicedSpan[] {
  const spans: VoicedSpan[] = [];
  const exitDb = thresholdDb - HYSTERESIS_DB;
  const { db, windowSeconds, offsetSeconds } = envelope;

  let start = -1;
  for (let index = 0; index < db.length; index++) {
    const level = db[index];
    if (start < 0) {
      if (level >= thresholdDb) {
        start = index;
      }
      continue;
    }
    if (level < exitDb) {
      spans.push(makeSpan(start, index, windowSeconds, offsetSeconds));
      start = -1;
    }
  }
  if (start >= 0) {
    spans.push(makeSpan(start, db.length, windowSeconds, offsetSeconds));
  }
  return spans;
}

function makeSpan(
  from: number,
  to: number,
  windowSeconds: number,
  offsetSeconds: number
): VoicedSpan {
  return {
    start: offsetSeconds + from * windowSeconds,
    end: offsetSeconds + to * windowSeconds,
    filler: false,
    // A onda não opina sobre o que ouviu: ou passou do limiar, ou não.
    // Confiança 1 neutraliza o filtro que só faz sentido na transcrição.
    confidence: 1,
  };
}

