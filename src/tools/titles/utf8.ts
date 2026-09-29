/**
 * UTF-8 na mão — bytes ⇄ texto, sem depender do ambiente.
 *
 * ── Por que não `TextDecoder` ──────────────────────────────────────
 * O UXP não tem. Medido na mão do editor: a primeira inserção morreu
 * em "TextDecoder is not defined" ao abrir o `definition.json` de
 * dentro do `.mogrt`. O `updater.ts` já tinha tropeçado nisso e caiu
 * em `decodeURIComponent(escape(...))` — que funciona, mas depende de
 * dois globais legados e lança em sequência malformada.
 *
 * Então aqui a conversão é explícita. São quarenta linhas, valem para
 * acento, emoji e ideograma, e não dependem de nada que possa faltar
 * na próxima versão do host.
 *
 * ── Blocos de 8 KB ────────────────────────────────────────────────
 * `String.fromCharCode(...array)` espalha cada byte como argumento, e
 * um `definition.json` de 12 KB já é doze mil argumentos. Acima de
 * algumas dezenas de milhares o motor recusa a chamada — daí montar
 * em pedaços.
 */

const CHUNK = 8192;

/** Texto → bytes UTF-8. Par de substitutos vira um caractere só. */
export function utf8Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 4);
  let at = 0;
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    // Emoji e afins chegam como DOIS code units; juntá-los é o que
    // evita gravar dois caracteres inválidos no lugar de um válido.
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      }
    }
    // Substituto solto não é caractere: entra como U+FFFD, que é o que
    // todo decodificador do mundo faria com ele.
    if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out[at] = code;
      at += 1;
    } else if (code < 0x800) {
      out[at] = 0xc0 | (code >> 6);
      out[at + 1] = 0x80 | (code & 0x3f);
      at += 2;
    } else if (code < 0x10000) {
      out[at] = 0xe0 | (code >> 12);
      out[at + 1] = 0x80 | ((code >> 6) & 0x3f);
      out[at + 2] = 0x80 | (code & 0x3f);
      at += 3;
    } else {
      out[at] = 0xf0 | (code >> 18);
      out[at + 1] = 0x80 | ((code >> 12) & 0x3f);
      out[at + 2] = 0x80 | ((code >> 6) & 0x3f);
      out[at + 3] = 0x80 | (code & 0x3f);
      at += 4;
    }
  }
  return out.subarray(0, at);
}

/**
 * Bytes UTF-8 → texto.
 *
 * Byte inválido ou sequência truncada vira U+FFFD e a leitura segue:
 * um `definition.json` com um byte torto no meio ainda tem noventa e
 * nove por cento de informação útil, e abortar entregaria zero.
 */
export function utf8Decode(bytes: Uint8Array): string {
  const units: number[] = [];
  let out = "";
  const flush = (): void => {
    if (units.length > 0) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  };

  for (let at = 0; at < bytes.length; ) {
    const first = bytes[at];
    let code: number;
    let size: number;
    // A faixa do SEGUNDO byte não é sempre 80–BF: em quatro aberturas
    // ela é mais estreita, e é justamente isso que barra a sequência
    // "longa demais" (o mesmo caractere escrito com bytes a mais) e a
    // faixa de substitutos. Sem estes limites, `E0 80 AF` passaria
    // como "/" — o truque clássico de escapar de uma validação.
    let lowSecond = 0x80;
    let highSecond = 0xbf;

    if (first < 0x80) {
      code = first;
      size = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      code = first & 0x1f;
      size = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      code = first & 0x0f;
      size = 3;
      if (first === 0xe0) lowSecond = 0xa0;
      if (first === 0xed) highSecond = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      code = first & 0x07;
      size = 4;
      if (first === 0xf0) lowSecond = 0x90;
      if (first === 0xf4) highSecond = 0x8f;
    } else {
      // 0x80–0xC1 e 0xF5–0xFF nunca abrem caractere.
      units.push(0xfffd);
      at += 1;
      continue;
    }

    let broken = false;
    for (let step = 1; step < size; step += 1) {
      const next = at + step < bytes.length ? bytes[at + step] : -1;
      const low = step === 1 ? lowSecond : 0x80;
      const high = step === 1 ? highSecond : 0xbf;
      if (next < low || next > high) {
        broken = true;
        break;
      }
      code = (code << 6) | (next & 0x3f);
    }
    if (broken) {
      // Anda UM byte só: o que interrompeu pode ser o começo de um
      // caractere válido, e engoli-lo perderia informação boa.
      units.push(0xfffd);
      at += 1;
      continue;
    }
    at += size;

    if (code < 0x10000) {
      units.push(code);
    } else {
      const rest = code - 0x10000;
      units.push(0xd800 + (rest >> 10), 0xdc00 + (rest & 0x3ff));
    }
    if (units.length >= CHUNK) {
      flush();
    }
  }
  flush();
  return out;
}
