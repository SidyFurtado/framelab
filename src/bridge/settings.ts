/**
 * Os ajustes de uma ferramenta, em disco.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * Legendas, Baixar e Silêncio já guardavam os seus. Zoom, Curvas,
 * Traduzir, Organizar e Muletas não guardavam nada: toda vez que o
 * painel fechava, os ajustes voltavam ao padrão. Quem sempre aplica um
 * punch de 115% em 1,6s remontava isso a cada sessão, e a encanação
 * para não remontar já existia em três lugares diferentes.
 *
 * Aqui mora só o encanamento — ler, escrever, não estourar nunca. A
 * validação campo a campo continua com cada ferramenta, através de
 * `sanitize`, porque é ela que sabe o que é um valor possível. Isso é
 * deliberado: um arquivo de ajustes editado à mão, ou vindo de uma
 * versão anterior sem algum campo, não pode produzir estado inválido.
 */
import { readText, workspace, write } from "../tools/silence/workspace";

export interface ToolSettings<T> {
  /** Lê do disco na primeira vez, depois responde da memória. */
  read(): Promise<T>;
  /**
   * O que já está em memória, ou `null` se o disco ainda não foi lido.
   *
   * O `mount` de uma ferramenta é síncrono: ele monta o HTML com os
   * valores iniciais antes que qualquer `await` possa acontecer. Por
   * isso cada ferramenta aquece o cache quando o módulo carrega, e o
   * `mount` desenha a partir daqui. Se por acaso ainda não estiver
   * quente, desenha o padrão e o `read()` seguinte corrige.
   */
  peek(): T | null;
  /** Substitui tudo. A gravação é adiada, ver `DEBOUNCE_MS`. */
  save(next: T): void;
  /** Muda alguns campos e grava. */
  patch(part: Partial<T>): void;
  /** Grava agora o que estiver pendente. Para o desmonte do painel. */
  flush(): Promise<void>;
}

/**
 * Quanto a gravação espera antes de ir ao disco.
 *
 * Arrastar um slider dispara uma mudança por quadro do mouse. Sem esta
 * espera, uma arrastada de dois segundos vira dezenas de escritas de
 * um arquivo que só a última versão interessa.
 */
const DEBOUNCE_MS = 400;

export function createToolSettings<T extends object>(
  file: string,
  defaults: T,
  sanitize: (raw: Partial<T>) => T
): ToolSettings<T> {
  let cache: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> | null = null;

  async function persist(): Promise<void> {
    const value = cache;
    if (!value) {
      return;
    }
    try {
      await write(await workspace(), file, JSON.stringify(value, null, 2));
    } catch (cause) {
      // Não conseguir gravar custa a lembrança na próxima sessão, e
      // nada além disso. A ferramenta segue com o valor em memória.
      console.warn(`[Ajustes] não consegui gravar ${file}:`, cause);
    }
  }

  function schedule(): void {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      writing = persist();
    }, DEBOUNCE_MS);
  }

  return {
    peek(): T | null {
      return cache ? { ...cache } : null;
    },

    async read(): Promise<T> {
      if (cache) {
        return { ...cache };
      }
      try {
        const raw = readText(await workspace(), file);
        cache = raw ? sanitize(JSON.parse(raw) as Partial<T>) : { ...defaults };
      } catch {
        // Arquivo ausente, corrompido ou ilegível: o padrão serve, e a
        // ferramenta abre em vez de falhar por causa de uma preferência.
        cache = { ...defaults };
      }
      return { ...cache };
    },

    save(next: T): void {
      cache = sanitize(next as Partial<T>);
      schedule();
    },

    patch(part: Partial<T>): void {
      cache = sanitize({ ...(cache ?? defaults), ...part });
      schedule();
    },

    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        writing = persist();
      }
      await writing;
    },
  };
}

/**
 * Começa a ler o arquivo já, sem esperar.
 *
 * Chamado quando o módulo da ferramenta carrega, para que o `mount`
 * — que é síncrono — encontre o cache quente e desenhe direto com os
 * ajustes salvos, em vez de piscar o padrão antes de corrigir.
 */
export function warmToolSettings<T extends object>(settings: ToolSettings<T>): void {
  void settings.read().catch(() => undefined);
}

/** Um número preso a um intervalo, com padrão quando não for número. */
export function clampNumber(
  raw: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/** Uma string, se for string não vazia. Senão, o padrão. */
export function pickString(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() !== "" ? raw : fallback;
}

/** Um valor de uma lista fechada, ou o padrão. */
export function pickOneOf<V extends string>(
  raw: unknown,
  allowed: readonly V[],
  fallback: V
): V {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as V)
    : fallback;
}
