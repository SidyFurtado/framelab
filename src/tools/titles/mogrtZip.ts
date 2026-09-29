/**
 * O `.mogrt` por dentro — ler uma entrada, e reescrever o pacote com
 * o `definition.json` trocado.
 *
 * ── Por que reescrever o pacote ────────────────────────────────────
 * No Premiere 26.5 a API do UXP não alcança o texto de um Motion
 * Graphics Template: os controles do Essential Graphics não estão na
 * cadeia de componentes, e `getMGTComponent` não existe (o 27 beta
 * anuncia `MogrtText` — quando chegar, este módulo vira atalho, não
 * obrigação). O que o host SEMPRE respeita é o que está dentro do
 * arquivo: o `definition.json` traz o texto, a fonte e o corpo de
 * fábrica. Então o painel gera uma cópia do modelo já com a frase
 * certa e insere a cópia.
 *
 * ── O que a cópia carrega ──────────────────────────────────────────
 * Só o que o Premiere usa para renderizar: `definition.json` novo e o
 * `project.aegraphic` original, copiado CRU — os bytes comprimidos
 * como vieram, sem inflar nem recomprimir 10 MB. O `thumb.png` vai
 * junto (dezenas de KB) porque não sei se o importador o exige e não
 * vale descobrir na timeline; o `thumb.mp4` fica de fora: numa legenda
 * de 40 peças, seriam 40 vídeos de 6 MB gravados para ninguém abrir.
 *
 * O `definition.json` novo vai SEM compressão (método 0). Escrever um
 * compressor só para poupar 6 KB seria trocar 30 linhas certas por
 * 300 discutíveis.
 *
 * ── Formato ────────────────────────────────────────────────────────
 * ZIP clássico (APPNOTE 4.4): cabeçalho local, dados, diretório
 * central, registro de fim. Tamanhos e CRC vêm SEMPRE do diretório
 * central — o cabeçalho local pode estar zerado quando o pacote foi
 * gravado em fluxo (bit 3), e é isso que quebra um leitor ingênuo.
 */
import { inflateRaw } from "./inflate";
import { utf8Decode, utf8Encode } from "./utf8";

export { utf8Decode, utf8Encode } from "./utf8";

export interface ZipEntry {
  readonly name: string;
  /** 0 = sem compressão, 8 = deflate. Outro = não sabemos ler. */
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc: number;
  /** Data e hora no formato DOS, copiados como vieram. */
  readonly dosTime: number;
  readonly dosDate: number;
  /** Onde os bytes (comprimidos) começam no pacote. */
  readonly dataOffset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * As entradas do pacote, lidas do diretório central.
 *
 * O registro de fim é procurado de trás para a frente porque pode
 * haver um comentário depois dele — nunca vi num .mogrt, mas custa
 * um laço.
 */
export function listEntries(zip: Uint8Array): ZipEntry[] {
  const view = viewOf(zip);
  let end = zip.length - 22;
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  while (end >= floor && view.getUint32(end, true) !== SIG_END) {
    end -= 1;
  }
  if (end < floor) {
    throw new Error("mogrt: não é um ZIP (sem registro de fim)");
  }
  const total = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);

  const entries: ZipEntry[] = [];
  for (let index = 0; index < total; index += 1) {
    if (view.getUint32(at, true) !== SIG_CENTRAL) {
      throw new Error("mogrt: diretório central corrompido");
    }
    const method = view.getUint16(at + 10, true);
    const dosTime = view.getUint16(at + 12, true);
    const dosDate = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = utf8Decode(zip.subarray(at + 46, at + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new Error(`mogrt: cabeçalho local de "${name}" corrompido`);
    }
    // O comprimento do campo extra LOCAL pode diferir do central — é
    // do local que se mede onde os dados começam.
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localName + localExtra;

    entries.push({ name, method, compressedSize, size, crc, dosTime, dosDate, dataOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Os bytes descompactados de uma entrada. */
export function readEntry(zip: Uint8Array, entry: ZipEntry): Uint8Array {
  const packed = zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) {
    return packed.slice();
  }
  if (entry.method === 8) {
    return inflateRaw(packed, entry.size);
  }
  throw new Error(`mogrt: "${entry.name}" usa compressão ${entry.method}, que não sei ler`);
}

/** O texto de uma entrada pelo nome, ou null quando ela não existe. */
export function readTextEntry(zip: Uint8Array, name: string): string | null {
  const entry = listEntries(zip).find((item) => item.name === name);
  return entry ? utf8Decode(readEntry(zip, entry)) : null;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Um escritor de bytes que cresce sozinho. */
class Sink {
  private buffer = new Uint8Array(1 << 16);
  length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) {
      return;
    }
    let size = this.buffer.length * 2;
    while (size < this.length + extra) {
      size *= 2;
    }
    const bigger = new Uint8Array(size);
    bigger.set(this.buffer.subarray(0, this.length));
    this.buffer = bigger;
  }

  u16(value: number): void {
    this.ensure(2);
    this.buffer[this.length] = value & 0xff;
    this.buffer[this.length + 1] = (value >>> 8) & 0xff;
    this.length += 2;
  }

  u32(value: number): void {
    this.ensure(4);
    this.buffer[this.length] = value & 0xff;
    this.buffer[this.length + 1] = (value >>> 8) & 0xff;
    this.buffer[this.length + 2] = (value >>> 16) & 0xff;
    this.buffer[this.length + 3] = (value >>> 24) & 0xff;
    this.length += 4;
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buffer.set(data, this.length);
    this.length += data.length;
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/** Uma entrada pronta para ser escrita: cabeçalho + bytes como vão para o disco. */
interface Outgoing {
  readonly name: Uint8Array;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly data: Uint8Array;
}

function writeZip(entries: readonly Outgoing[]): Uint8Array {
  const sink = new Sink();
  const offsets: number[] = [];

  for (const entry of entries) {
    offsets.push(sink.length);
    sink.u32(SIG_LOCAL);
    sink.u16(20); // versão necessária: 2.0, o ZIP de sempre
    sink.u16(0); // flags: sem descritor de dados, sem criptografia
    sink.u16(entry.method);
    sink.u16(entry.dosTime);
    sink.u16(entry.dosDate);
    sink.u32(entry.crc);
    sink.u32(entry.compressedSize);
    sink.u32(entry.size);
    sink.u16(entry.name.length);
    sink.u16(0); // sem campo extra
    sink.bytes(entry.name);
    sink.bytes(entry.data);
  }

  const centralStart = sink.length;
  entries.forEach((entry, index) => {
    sink.u32(SIG_CENTRAL);
    sink.u16(20); // feito por: 2.0
    sink.u16(20); // necessário: 2.0
    sink.u16(0);
    sink.u16(entry.method);
    sink.u16(entry.dosTime);
    sink.u16(entry.dosDate);
    sink.u32(entry.crc);
    sink.u32(entry.compressedSize);
    sink.u32(entry.size);
    sink.u16(entry.name.length);
    sink.u16(0); // extra
    sink.u16(0); // comentário
    sink.u16(0); // disco
    sink.u16(0); // atributos internos
    sink.u32(0); // atributos externos
    sink.u32(offsets[index]);
    sink.bytes(entry.name);
  });
  const centralSize = sink.length - centralStart;

  sink.u32(SIG_END);
  sink.u16(0);
  sink.u16(0);
  sink.u16(entries.length);
  sink.u16(entries.length);
  sink.u32(centralSize);
  sink.u32(centralStart);
  sink.u16(0);
  return sink.result();
}

/** As entradas que a cópia NÃO precisa carregar. */
const DROPPED = new Set(["thumb.mp4"]);

/**
 * O mesmo pacote, com outro `definition.json` e sem as miniaturas.
 *
 * O `definition.json` vai primeiro e sem compressão; o resto é copiado
 * byte a byte, comprimido como estava — CRC e tamanhos vêm do
 * diretório central do original, que é a fonte que vale.
 */
export function rewriteMogrt(zip: Uint8Array, definitionJson: string): Uint8Array {
  const entries = listEntries(zip);
  const original = entries.find((entry) => entry.name === "definition.json");
  if (!original) {
    throw new Error("mogrt: o pacote não tem definition.json");
  }
  const definition = utf8Encode(definitionJson);
  const outgoing: Outgoing[] = [
    {
      name: utf8Encode("definition.json"),
      method: 0,
      crc: crc32(definition),
      compressedSize: definition.length,
      size: definition.length,
      dosTime: original.dosTime,
      dosDate: original.dosDate,
      data: definition,
    },
  ];
  for (const entry of entries) {
    if (entry.name === "definition.json" || DROPPED.has(entry.name)) {
      continue;
    }
    outgoing.push({
      name: utf8Encode(entry.name),
      method: entry.method,
      crc: entry.crc,
      compressedSize: entry.compressedSize,
      size: entry.size,
      dosTime: entry.dosTime,
      dosDate: entry.dosDate,
      data: zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize),
    });
  }
  return writeZip(outgoing);
}
