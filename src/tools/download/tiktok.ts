/**
 * TikTok — a via rápida, sem yt-dlp.
 *
 * ── Por que existe ─────────────────────────────────────────────────
 * Os sites de "baixar TikTok sem marca" respondem em três segundos
 * porque não raspam a página do TikTok: eles consultam uma API que
 * devolve o link direto do MP4 no CDN, já sem marca d'água. O yt-dlp
 * raspa — e a raspagem dele quebra em rajadas ("unable to extract
 * universal data") e custa dezenas de segundos. Um beta tester
 * comparou o painel com o site e o site ganhou; esta via é a resposta.
 *
 * O painel consulta a MESMA classe de API (tikwm.com) por fetch — que
 * o plugin já usa no auto-update — e entrega ao script só um curl com
 * o link direto. Sem raspagem de página, sem provisionar 35 MB de
 * yt-dlp para quem só baixa TikTok, sem motor JS.
 *
 * ── E quando a API falhar ──────────────────────────────────────────
 * É serviço de terceiro: pode cair, pode limitar. Toda função aqui
 * devolve null em vez de lançar, e quem chama manda a URL para o
 * caminho do yt-dlp — mais lento e mais teimoso. A via rápida é um
 * atalho, nunca a única porta.
 */

const API = "https://www.tikwm.com/api/";
/** A API limita ~1 req/s; consultas em lote respeitam esse passo. */
const BATCH_STEP_MS = 1100;
const TIMEOUT_MS = 8000;

export interface TikTokFast {
  id: string;
  title: string;
  durationSeconds: number | null;
  /** Link direto SEM marca, definição padrão. */
  playUrl: string;
  /** Link direto SEM marca em HD. Nem todo vídeo tem. */
  hdUrl: string | null;
  /** MP3 da trilha, quando a API entrega. */
  musicUrl: string | null;
  sizeSd: number;
  sizeHd: number;
}

export function isTikTokUrl(url: string): boolean {
  // O teste olha só o HOST. Uma substring na URL inteira mandava para
  // a via rápida qualquer link que citasse tiktok.com na query — um
  // wrapper de compartilhamento, por exemplo.
  const host = url.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0];
  return /(^|\.)tiktok\.com$/i.test(host);
}

/** Consulta um link. null = use o yt-dlp; nunca lança. */
export async function fetchTikTokFast(url: string): Promise<TikTokFast | null> {
  try {
    const response = await withTimeout(
      fetch(`${API}?url=${encodeURIComponent(url)}&hd=1`, {
        headers: { Accept: "application/json" },
      })
    );
    if (!response || !response.ok) {
      return null;
    }
    const body = (await withTimeout(response.json())) as {
      code?: number;
      data?: Record<string, unknown>;
    } | null;
    if (!body || body.code !== 0 || !body.data) {
      return null;
    }
    const data = body.data;

    const playUrl = absolute(text(data.play));
    if (!playUrl) {
      return null;
    }
    return {
      id: text(data.id) || "tiktok",
      title: text(data.title) || "TikTok",
      durationSeconds: num(data.duration),
      playUrl,
      hdUrl: absolute(text(data.hdplay)),
      musicUrl: absolute(text(data.music)),
      sizeSd: num(data.size) ?? 0,
      sizeHd: num(data.hd_size) ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Consulta vários, no passo que a API aceita. O resultado casa por
 * índice com a entrada; null nas posições em que a via rápida falhou.
 */
export async function fetchManyTikTok(
  urls: readonly string[]
): Promise<Array<TikTokFast | null>> {
  const out: Array<TikTokFast | null> = [];
  for (let index = 0; index < urls.length; index += 1) {
    if (index > 0) {
      await wait(BATCH_STEP_MS);
    }
    out.push(await fetchTikTokFast(urls[index]));
  }
  return out;
}

/**
 * Nome de arquivo a partir do título, sem os caracteres que quebram
 * disco ou timeline. O id entra para duas cópias do mesmo vídeo não
 * se atropelarem.
 */
export function tiktokFileName(info: TikTokFast, extension: string): string {
  const safe = info.title
    .replace(/[\\/:*?"<>|#%&{}$!@`'+=~\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return `${safe || "tiktok"} [${info.id}].${extension}`;
}

function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([
    promise,
    wait(TIMEOUT_MS).then(() => null as T | null),
  ]);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A API ora devolve caminho relativo, ora absoluto. */
function absolute(value: string): string | null {
  if (!value) {
    return null;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `https://www.tikwm.com${value.startsWith("/") ? "" : "/"}${value}`;
}
