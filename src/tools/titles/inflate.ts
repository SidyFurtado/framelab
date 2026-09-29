/**
 * Inflate — o descompactador do Deflate (RFC 1951), em JavaScript puro.
 *
 * ── Por que escrever um ────────────────────────────────────────────
 * O `.mogrt` é um ZIP e TODA entrada dele vem comprimida. O painel
 * precisa ler o `definition.json` de dentro para trocar o texto — e
 * o UXP não traz `DecompressionStream`, `zlib` nem nada parecido.
 * Sem isto, o caminho seria um cache gerado por fora do plugin, que
 * envelhece na primeira vez que alguém larga um modelo novo na pasta.
 *
 * ── O que ele NÃO precisa ser ──────────────────────────────────────
 * Rápido. Só o `definition.json` (8–12 KB) passa por aqui; o
 * `project.aegraphic` de 10 MB é copiado cru, comprimido como veio.
 * Por isso a decodificação de Huffman é a canônica, bit a bit — a
 * forma que dá para conferir de cabeça contra a RFC, sem tabelas
 * pré-computadas que só serviriam para ganhar milissegundos que
 * ninguém aqui sente.
 *
 * Testado contra o `zlib` do Node em `test/inflate.test.ts`.
 */

/** Comprimentos base e bits extras dos símbolos 257..285 (RFC 1951 §3.2.5). */
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
/** Distâncias base e bits extras dos símbolos 0..29. */
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
  769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];
/** A ordem maluca em que os comprimentos do código de comprimentos chegam. */
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const MAX_BITS = 15;

/** Um código de Huffman canônico: quantos códigos de cada tamanho, e os símbolos em ordem. */
interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
}

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
  const count = new Uint16Array(MAX_BITS + 1);
  for (let i = 0; i < n; i += 1) {
    count[lengths[i]] += 1;
  }
  count[0] = 0;
  const offsets = new Uint16Array(MAX_BITS + 2);
  for (let len = 1; len <= MAX_BITS; len += 1) {
    offsets[len + 1] = offsets[len] + count[len];
  }
  const symbol = new Uint16Array(n);
  for (let i = 0; i < n; i += 1) {
    if (lengths[i] !== 0) {
      symbol[offsets[lengths[i]]] = i;
      offsets[lengths[i]] += 1;
    }
  }
  return { count, symbol };
}

class BitReader {
  private readonly input: Uint8Array;
  private pos = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  // Campo declarado à mão, e não `constructor(private input)`: o Node
  // roda os testes em modo strip-only, que não aceita a forma curta.
  constructor(input: Uint8Array) {
    this.input = input;
  }

  bits(need: number): number {
    let value = this.bitBuffer;
    while (this.bitCount < need) {
      if (this.pos >= this.input.length) {
        throw new Error("deflate: fim inesperado dos dados");
      }
      value |= this.input[this.pos] << this.bitCount;
      this.pos += 1;
      this.bitCount += 8;
    }
    this.bitBuffer = value >>> need;
    this.bitCount -= need;
    return value & ((1 << need) - 1);
  }

  /** Bloco sem compressão começa alinhado em byte. */
  alignToByte(): void {
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  bytes(length: number): Uint8Array {
    if (this.pos + length > this.input.length) {
      throw new Error("deflate: bloco sem compressão passa do fim");
    }
    const slice = this.input.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  decode(code: Huffman): number {
    let value = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAX_BITS; len += 1) {
      value |= this.bits(1);
      const count = code.count[len];
      if (value - count < first) {
        return code.symbol[index + (value - first)];
      }
      index += count;
      first += count;
      first <<= 1;
      value <<= 1;
    }
    throw new Error("deflate: código de Huffman inválido");
  }
}

class Output {
  private buffer: Uint8Array;
  length = 0;

  constructor(expected: number) {
    this.buffer = new Uint8Array(Math.max(expected, 1024));
  }

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

  push(byte: number): void {
    this.ensure(1);
    this.buffer[this.length] = byte;
    this.length += 1;
  }

  pushAll(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  /** Copia `length` bytes de `distance` atrás — a cópia pode se sobrepor. */
  copyBack(distance: number, length: number): void {
    if (distance > this.length) {
      throw new Error("deflate: distância aponta antes do começo");
    }
    this.ensure(length);
    let from = this.length - distance;
    for (let i = 0; i < length; i += 1) {
      this.buffer[this.length] = this.buffer[from];
      this.length += 1;
      from += 1;
    }
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

let fixedLiteral: Huffman | null = null;
let fixedDistance: Huffman | null = null;

function fixedCodes(): { literal: Huffman; distance: Huffman } {
  if (!fixedLiteral || !fixedDistance) {
    const lengths = new Uint8Array(288);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    fixedLiteral = buildHuffman(lengths, 288);
    const dist = new Uint8Array(30);
    dist.fill(5);
    fixedDistance = buildHuffman(dist, 30);
  }
  return { literal: fixedLiteral, distance: fixedDistance };
}

function inflateCodes(
  reader: BitReader,
  out: Output,
  literal: Huffman,
  distance: Huffman
): void {
  for (;;) {
    const symbol = reader.decode(literal);
    if (symbol < 256) {
      out.push(symbol);
      continue;
    }
    if (symbol === 256) {
      return;
    }
    const li = symbol - 257;
    if (li >= LENGTH_BASE.length) {
      throw new Error("deflate: símbolo de comprimento inválido");
    }
    const length = LENGTH_BASE[li] + reader.bits(LENGTH_EXTRA[li]);
    const di = reader.decode(distance);
    if (di >= DIST_BASE.length) {
      throw new Error("deflate: símbolo de distância inválido");
    }
    const dist = DIST_BASE[di] + reader.bits(DIST_EXTRA[di]);
    out.copyBack(dist, length);
  }
}

function dynamicCodes(reader: BitReader): { literal: Huffman; distance: Huffman } {
  const nlen = reader.bits(5) + 257;
  const ndist = reader.bits(5) + 1;
  const ncode = reader.bits(4) + 4;
  if (nlen > 286 || ndist > 30) {
    throw new Error("deflate: tabela dinâmica fora dos limites");
  }
  const codeLengths = new Uint8Array(19);
  for (let i = 0; i < ncode; i += 1) {
    codeLengths[CODE_ORDER[i]] = reader.bits(3);
  }
  const codeCode = buildHuffman(codeLengths, 19);

  const lengths = new Uint8Array(nlen + ndist);
  let index = 0;
  while (index < nlen + ndist) {
    const symbol = reader.decode(codeCode);
    if (symbol < 16) {
      lengths[index] = symbol;
      index += 1;
      continue;
    }
    let repeat: number;
    let value = 0;
    if (symbol === 16) {
      if (index === 0) {
        throw new Error("deflate: repetição sem comprimento anterior");
      }
      value = lengths[index - 1];
      repeat = 3 + reader.bits(2);
    } else if (symbol === 17) {
      repeat = 3 + reader.bits(3);
    } else {
      repeat = 11 + reader.bits(7);
    }
    if (index + repeat > nlen + ndist) {
      throw new Error("deflate: repetição passa da tabela");
    }
    lengths.fill(value, index, index + repeat);
    index += repeat;
  }
  return {
    literal: buildHuffman(lengths.subarray(0, nlen), nlen),
    distance: buildHuffman(lengths.subarray(nlen), ndist),
  };
}

/**
 * Descompacta um fluxo Deflate CRU (sem cabeçalho zlib nem gzip) —
 * que é a forma em que uma entrada de ZIP vem.
 *
 * @param expected O tamanho descompactado, quando conhecido; só evita
 *   realocar o buffer de saída.
 */
export function inflateRaw(input: Uint8Array, expected = 0): Uint8Array {
  const reader = new BitReader(input);
  const out = new Output(expected);
  let last = 0;
  do {
    last = reader.bits(1);
    const type = reader.bits(2);
    if (type === 0) {
      reader.alignToByte();
      const header = reader.bytes(4);
      const length = header[0] | (header[1] << 8);
      const check = header[2] | (header[3] << 8);
      if ((length ^ 0xffff) !== check) {
        throw new Error("deflate: bloco sem compressão com tamanho corrompido");
      }
      out.pushAll(reader.bytes(length));
    } else if (type === 1) {
      const { literal, distance } = fixedCodes();
      inflateCodes(reader, out, literal, distance);
    } else if (type === 2) {
      const { literal, distance } = dynamicCodes(reader);
      inflateCodes(reader, out, literal, distance);
    } else {
      throw new Error("deflate: tipo de bloco reservado");
    }
  } while (!last);
  return out.result();
}
