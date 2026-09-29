/**
 * De onde a prévia toca — sem guardar o pack no computador.
 *
 * ── Por que não o link do Drive direto ─────────────────────────────
 * Foi a primeira versão, e não tocou: com o Premiere na frente, o
 * player do UXP ficou doze segundos sem nem ler o cabeçalho do link
 * (print do editor, 2026-09-22). `blob:` e `data:` ele recusa. O único
 * caminho que tocou do começo ao fim foi um ARQUIVO.
 *
 * ── Então: memória + arquivo temporário descartável ────────────────
 * O `fetch` do UXP baixa o som do Drive sem problema (~1,5 s). Os bytes
 * ficam na memória do painel — ouvir de novo não vai ao Drive — e, para
 * o player, viram um arquivo na pasta TEMPORÁRIA do sistema, apagado
 * assim que a prévia termina, é parada ou dá lugar a outra. Nada fica
 * guardado: foi pedido que o pack não fosse baixado para o computador
 * de quem só quer ouvir, e é isso que se cumpre aqui. Se o painel cair
 * no meio, o que sobrar está na pasta temporária, que o macOS limpa.
 *
 * O som que já está na pasta dos SFX (se o editor escolheu uma) não
 * vai ao Drive: o painel lê os bytes de lá. Mas o player recebe SEMPRE a
 * cópia temporária — quem toca de verdade é o `afplay` do assistente
 * (ver `native.ts`), e o macOS não o deixa ler a pasta do Google Drive.
 */
import { fileUrl, fsModule, join, uxpModule } from "../silence/workspace";
import { downloadSound } from "./drive";
import type { SfxVariant } from "./pack";
import { copiedBytes, markEmpty } from "./store";

/** Teto da memória de sons já ouvidos nesta sessão. */
const MEMORY_LIMIT = 48 * 1024 * 1024;
/** Um som maior que isto toca, mas não fica na memória. */
const MEMORY_ITEM_LIMIT = 12 * 1024 * 1024;

/** id → bytes. A ordem de inserção é a ordem de uso (o mais velho sai primeiro). */
const memory = new Map<string, ArrayBuffer>();
let memoryBytes = 0;
let counter = 0;
let tempNative: string | null = null;

/** O trecho de silêncio que destrava a prévia no clique (ver `player.ts`). */
let silence: string | null = null;

/** 0,3 s de silêncio, 8 kHz mono 16 bits: 4,8 KB. */
function silentWav(seconds = 0.3, rate = 8000): Uint8Array {
  const dataBytes = Math.round(seconds * rate) * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

/**
 * Deixa o silêncio pronto no disco. Chamado quando a ferramenta abre:
 * no clique não há tempo para `await` — o destravamento tem de ser
 * síncrono, dentro do gesto.
 */
export async function warmSilence(): Promise<void> {
  if (silence) return;
  try {
    const fs = fsModule();
    if (!fs) return;
    fs.writeFileSync("plugin-temp:/framelab-silence.wav", silentWav());
    silence = fileUrl(join(await temporaryFolder(), "framelab-silence.wav"));
  } catch {
    // Sem silêncio, o destravamento vai sem src; as outras maneiras seguem.
  }
}

export function silenceUrl(): string | null {
  return silence;
}

export type PreviewSource =
  | { kind: "ready"; url: string; release(): void }
  | { kind: "empty" };

/** true quando tocar este som não precisa ir ao Drive. */
export function isNearby(variant: SfxVariant): boolean {
  return memory.has(variant.id);
}

/** Guarda bytes que acabaram de chegar por outro caminho (o download para a pasta). */
export function remember(variant: SfxVariant, data: ArrayBuffer): void {
  keep(variant.id, data);
}

/** Os bytes do som: da memória, da pasta dos SFX ou do Drive, nessa ordem. */
async function bytesFor(variant: SfxVariant): Promise<ArrayBuffer | "empty"> {
  const held = memory.get(variant.id);
  if (held) {
    keep(variant.id, held);
    return held;
  }
  const local = await copiedBytes(variant).catch(() => null);
  if (local && local.byteLength > 0) {
    keep(variant.id, local);
    return local;
  }
  const data = await downloadSound(variant.id);
  if (data.byteLength === 0) {
    markEmpty(variant);
    return "empty";
  }
  keep(variant.id, data);
  return data;
}

function keep(id: string, bytes: ArrayBuffer): void {
  if (bytes.byteLength > MEMORY_ITEM_LIMIT) return;
  const held = memory.get(id);
  if (held) {
    memory.delete(id);
    memoryBytes -= held.byteLength;
  }
  memory.set(id, bytes);
  memoryBytes += bytes.byteLength;
  for (const [oldest, data] of memory) {
    if (memoryBytes <= MEMORY_LIMIT) break;
    memory.delete(oldest);
    memoryBytes -= data.byteLength;
  }
}

async function temporaryFolder(): Promise<string> {
  if (tempNative) return tempNative;
  const lfs = uxpModule<{
    storage?: { localFileSystem?: { getTemporaryFolder?(): Promise<{ nativePath?: string }> } };
  }>("uxp")?.storage?.localFileSystem;
  const folder = await lfs?.getTemporaryFolder?.();
  if (!folder?.nativePath) {
    throw new Error("a pasta temporária do UXP não respondeu");
  }
  tempNative = folder.nativePath;
  return tempNative;
}

/**
 * O endereço que o player recebe, e como devolvê-lo.
 *
 * `release()` apaga o arquivo temporário. Chamar duas vezes, ou
 * chamar para uma cópia offline, não faz nada.
 */
export async function previewSource(variant: SfxVariant): Promise<PreviewSource> {
  const bytes = await bytesFor(variant);
  if (bytes === "empty") {
    return { kind: "empty" };
  }

  const fs = fsModule();
  if (!fs) {
    throw new Error('require("fs") não resolveu');
  }
  // Nome novo a cada prévia: o player não pode achar que é o mesmo
  // arquivo de antes e reaproveitar um carregamento velho.
  counter += 1;
  const name = `framelab-sfx-${counter}-${Date.now().toString(36)}.${variant.ext || "wav"}`;
  const route = `plugin-temp:/${name}`;
  fs.writeFileSync(route, new Uint8Array(bytes));
  const url = fileUrl(join(await temporaryFolder(), name));

  let released = false;
  return {
    kind: "ready",
    url,
    release: () => {
      if (released) return;
      released = true;
      void fs.unlink(route).catch(() => undefined);
    },
  };
}
