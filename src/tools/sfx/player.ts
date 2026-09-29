/**
 * A prévia: ouvir o som dentro do painel.
 *
 * ── O que se sabe do <video> do UXP (Premiere 26.5.1, UXP 9.3) ─────
 * Não há `Audio`, `<audio>` nem Web Audio; o `<video>` abre arquivo só
 * de áudio e lê a duração certa. Tocar é outra história, e é aqui que
 * mora a dúvida: `play()` resolve a promessa e o tempo fica em 0,00;
 * uma única vez, numa sonda, `autoplay` + `play()` no `loadedmetadata`
 * tocou o Pop até o fim — e a mesma receita falhou em todas as vezes
 * seguintes, inclusive no clique do editor. `blob:` e `data:` são
 * recusados; só arquivo carrega.
 *
 * ── Por isso: várias maneiras, em sequência, com relatório ─────────
 * A suspeita principal é a regra de "só toca em resposta a um gesto":
 * quando o arquivo fica pronto (1–2 s de Drive depois do clique), o
 * clique já passou. Então a prévia é DESTRAVADA no próprio clique
 * (`prime`, com um trecho de silêncio) e o mesmo elemento recebe o som
 * depois. Se o tempo não andar, tenta a próxima maneira — até uma
 * tocar. Cada tentativa, com cada evento e o tempo em que chegou, vai
 * para `sfx-preview-report.txt` na pasta de dados do plugin: é o que
 * diz, na próxima vez, qual caminho o host aceita, sem depender de um
 * print.
 *
 * Logo depois da primeira maneira vem o `afplay` do macOS, pelo
 * assistente do Framelab (ver `native.ts`): no teste em segundo plano,
 * todas as maneiras do <video> ficaram com o tempo parado em 0,00. A que
 * tocar vira a primeira da próxima prévia, então só a primeira prévia
 * da sessão paga a espera das tentativas.
 */
import { readText, workspace, write } from "../silence/workspace";
import { nativeAvailable, nativeFileOf, playNative, stopNative } from "./native";

export interface PlayHandlers {
  /** Começou a tocar. A duração vem quando o player já sabe. */
  onStart(seconds: number | null): void;
  onEnd(): void;
  onError(message: string): void;
}

/** Quanto cada maneira do <video> tem para fazer o tempo andar. */
const TRY_MS = 1500;
const NATIVE = "afplay pelo assistente";
const REPORT_FILE = "sfx-preview-report.txt";
/** A maneira que tocou, guardada entre sessões. */
const WINNER_FILE = "sfx-player.txt";
/** O relatório guarda só as últimas tentativas. */
const REPORT_LIMIT = 24000;

interface Strategy {
  name: string;
  /** Monta e dispara. Devolve o elemento que está tentando. */
  run(url: string, log: (line: string) => void): HTMLVideoElement;
}

/** O `afplay` tocando agora — para parar, é outro caminho. */
let nativeActive = false;
/** A última duração que algum <video> leu, para o `afplay` saber quando acaba. */
let lastSeconds: number | null = null;

let current: HTMLVideoElement | null = null;
let timers: Array<ReturnType<typeof setTimeout>> = [];
let generation = 0;
/** O elemento destravado no clique, esperando o som de verdade. */
let primed: HTMLVideoElement | null = null;
/** Onde a maneira "visível" põe o elemento: a linha do som. */
let host: HTMLElement | null = null;
/** A maneira que funcionou por último — tentada primeiro na próxima. */
let winner: string | null = null;

/**
 * Lê qual maneira tocou na sessão anterior. Sem isto, a primeira prévia
 * de cada sessão esperava a maneira do <video> falhar (1,5 s) antes de
 * chegar à que toca.
 */
export async function warmPlayer(): Promise<void> {
  if (winner) return;
  try {
    const saved = readText(await workspace(), WINNER_FILE);
    if (saved && (saved === NATIVE || STRATEGIES.some((item) => item.name === saved))) {
      winner = saved;
    }
  } catch {
    // Sem lembrança: tenta na ordem.
  }
}

function crown(name: string): void {
  if (winner === name) return;
  winner = name;
  void (async () => {
    try {
      await write(await workspace(), WINNER_FILE, name);
    } catch {
      // Esquecer a lembrança custa 1,5 s na próxima sessão, só isso.
    }
  })();
}

function baseElement(): HTMLVideoElement {
  const element = document.createElement("video") as HTMLVideoElement;
  element.setAttribute("aria-hidden", "true");
  element.style.position = "absolute";
  element.style.width = "1px";
  element.style.height = "1px";
  element.style.pointerEvents = "none";
  return element;
}

function finiteSeconds(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function safePlay(element: HTMLVideoElement, log: (line: string) => void, tag: string): void {
  try {
    const pending = element.play() as Promise<void> | undefined;
    if (pending && typeof pending.then === "function") {
      pending.then(
        () => log(`${tag}: play() resolveu`),
        (cause: unknown) => log(`${tag}: play() recusou (${String(cause)})`)
      );
    } else {
      log(`${tag}: play() voltou ${typeof pending}`);
    }
  } catch (cause) {
    log(`${tag}: play() lançou (${String(cause)})`);
  }
}

/**
 * Destrava a prévia no gesto do editor. Chamar DENTRO do clique (ou da
 * tecla), antes de qualquer `await`: é o que faz o host entender que
 * foi o editor quem pediu o som.
 */
export function prime(silence: string | null): void {
  dropPrimed();
  const element = baseElement();
  element.autoplay = true;
  document.body.appendChild(element);
  primed = element;
  if (silence) element.src = silence;
  try {
    const pending = element.play() as Promise<void> | undefined;
    pending?.catch?.(() => undefined);
  } catch {
    // Sem src ainda, alguns players recusam; destravar é tentativa.
  }
}

function dropPrimed(): void {
  if (!primed) return;
  try {
    primed.pause();
  } catch {
    // já parado
  }
  primed.remove();
  primed = null;
}

/** A linha do som, para a maneira que precisa de um elemento visível. */
export function setHost(element: HTMLElement | null): void {
  host = element;
}

const STRATEGIES: Strategy[] = [
  {
    // O elemento destravado no clique recebe o som de verdade.
    name: "destravado no clique",
    run(url, log) {
      const element = primed ?? baseElement();
      if (!primed) log("sem elemento destravado — elemento novo");
      primed = null;
      if (!element.isConnected) document.body.appendChild(element);
      element.autoplay = true;
      element.addEventListener("loadedmetadata", () => safePlay(element, log, "loadedmetadata"));
      element.src = url;
      safePlay(element, log, "logo após src");
      return element;
    },
  },
  {
    // A receita da sonda que tocou uma vez.
    name: "autoplay + play() no loadedmetadata",
    run(url, log) {
      const element = baseElement();
      element.autoplay = true;
      element.addEventListener("loadedmetadata", () => safePlay(element, log, "loadedmetadata"));
      document.body.appendChild(element);
      element.src = url;
      return element;
    },
  },
  {
    // Como a Adobe faz nos painéis dela: um <video> de verdade, visível,
    // dentro da interface, com carregamento completo antes do play().
    name: "visível na linha, load() + play() no canplay",
    run(url, log) {
      const element = document.createElement("video") as HTMLVideoElement;
      element.setAttribute("aria-hidden", "true");
      element.className = "sfx-player-visible";
      element.preload = "auto";
      element.addEventListener("canplay", () => safePlay(element, log, "canplay"));
      element.addEventListener("loadedmetadata", () => safePlay(element, log, "loadedmetadata"));
      (host?.isConnected ? host : document.body).appendChild(element);
      element.src = url;
      try {
        element.load();
      } catch (cause) {
        log(`load() lançou (${String(cause)})`);
      }
      return element;
    },
  },
  {
    // Autoplay mudo costuma passar onde o com som é barrado; o som
    // liga assim que o tempo anda.
    name: "mudo, liga o som ao andar",
    run(url, log) {
      const element = baseElement();
      element.muted = true;
      element.autoplay = true;
      let unmuted = false;
      element.addEventListener("timeupdate", () => {
        if (!unmuted && element.currentTime > 0) {
          unmuted = true;
          element.muted = false;
          element.volume = 1;
          log("som ligado");
        }
      });
      element.addEventListener("loadedmetadata", () => safePlay(element, log, "loadedmetadata"));
      document.body.appendChild(element);
      element.src = url;
      return element;
    },
  },
];

/** A ordem de tentar: a que tocou da última vez na frente. */
function ordered(): string[] {
  const names = STRATEGIES.map((item) => item.name);
  // O afplay entra logo depois da primeira maneira do <video>.
  names.splice(1, 0, NATIVE);
  if (!winner || !names.includes(winner)) return names;
  return [winner, ...names.filter((name) => name !== winner)];
}

// ── o relatório ────────────────────────────────────────────────────

let report: string[] = [];

function clock(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

async function flushReport(): Promise<void> {
  if (report.length === 0) return;
  const block = report.join("\n");
  report = [];
  try {
    const space = await workspace();
    const before = readText(space, REPORT_FILE) ?? "";
    const text = `${before}\n${block}\n`;
    await write(space, REPORT_FILE, text.length > REPORT_LIMIT ? text.slice(-REPORT_LIMIT) : text);
  } catch {
    // Sem relatório, a prévia segue igual.
  }
}

function describeState(element: HTMLVideoElement): string {
  const error = element.error ? ` erro=${element.error.code} ${element.error.message}` : "";
  return (
    `t=${(element.currentTime || 0).toFixed(2)} dur=${String(finiteSeconds(element.duration) ?? "?")} ` +
    `paused=${String(element.paused)} muted=${String(element.muted)} vol=${String(element.volume)}${error}`
  );
}

// ── tocar ──────────────────────────────────────────────────────────

/**
 * Toca uma URL, largando qualquer prévia anterior. `label` só vai para
 * o relatório.
 */
export function playUrl(url: string, handlers: PlayHandlers, label = ""): void {
  stopPlayback(false);
  const token = generation;
  const started = Date.now();
  report.push(`── ${clock()} · ${label} · ${url.slice(0, 160)}`);
  const queue = ordered();
  let attempt = 0;

  const next = (): void => {
    if (token !== generation) return;
    const name = queue[attempt];
    attempt += 1;
    if (name === NATIVE) {
      tryNative();
      return;
    }
    const strategy = STRATEGIES.find((item) => item.name === name);
    if (!strategy) {
      report.push("   resultado: nenhuma maneira tocou");
      void flushReport();
      stopPlayback(false);
      handlers.onError("o player abriu o arquivo mas não tocou (detalhes em sfx-preview-report.txt)");
      return;
    }

    const t0 = Date.now();
    const log = (line: string): void => {
      report.push(`   [${strategy.name}] +${Date.now() - t0}ms ${line}`);
    };
    let playing = false;
    let element: HTMLVideoElement;
    try {
      element = strategy.run(url, log);
    } catch (cause) {
      log(`falhou ao montar (${String(cause)})`);
      next();
      return;
    }
    current = element;

    for (const name of ["loadedmetadata", "canplay", "play", "playing", "pause", "stalled", "waiting"]) {
      element.addEventListener(name, () => {
        if (token === generation && current === element) log(`${name} · ${describeState(element)}`);
      });
    }

    const succeed = (): void => {
      if (playing || token !== generation || current !== element) return;
      playing = true;
      crown(strategy.name);
      log(`TOCOU · ${describeState(element)} · ${Date.now() - started}ms desde o pedido`);
      void flushReport();
      const seconds = finiteSeconds(element.duration);
      handlers.onStart(seconds);
      if (seconds !== null) {
        timers.push(
          setTimeout(() => {
            if (token !== generation) return;
            stopPlayback(false);
            handlers.onEnd();
          }, seconds * 1000 + 1500)
        );
      }
    };

    element.addEventListener("loadedmetadata", () => {
      lastSeconds = finiteSeconds(element.duration) ?? lastSeconds;
    });
    element.addEventListener("timeupdate", () => {
      if (element.currentTime > 0) succeed();
    });
    element.addEventListener("ended", () => {
      if (token !== generation || current !== element) return;
      log(`ended · ${describeState(element)}`);
      if (!playing) succeed();
      void flushReport();
      stopPlayback(false);
      handlers.onEnd();
    });
    element.addEventListener("error", () => {
      if (token !== generation || current !== element) return;
      log(`error · ${describeState(element)}`);
      if (!playing) {
        discard(element);
        next();
      }
    });
    timers.push(
      setTimeout(() => {
        if (playing || token !== generation || current !== element) return;
        log(`não andou em ${TRY_MS}ms · ${describeState(element)}`);
        discard(element);
        next();
      }, TRY_MS)
    );
  };

  /** O `afplay`: sem eventos, o sinal é o carimbo que o script escreve. */
  const tryNative = (): void => {
    const t0 = Date.now();
    const log = (line: string): void => {
      report.push(`   [${NATIVE}] +${Date.now() - t0}ms ${line}`);
    };
    const file = nativeFileOf(url);
    if (!file || !nativeAvailable()) {
      log(file ? "só existe no macOS — pulado" : "não é arquivo local — pulado");
      next();
      return;
    }
    void (async () => {
      // A duração vem do cabeçalho: é por ela que a linha sabe quando
      // o som acabou, já que o afplay não avisa.
      const seconds = lastSeconds ?? (await probeDuration(url));
      if (token !== generation) return;
      log("pedindo ao assistente…");
      const result = await playNative(file);
      if (token !== generation) {
        if (result.ok) void stopNative();
        return;
      }
      if (!result.ok) {
        log(`falhou · ${result.detail}`);
        next();
        return;
      }
      nativeActive = true;
      crown(NATIVE);
      // O elemento destravado no clique não vai ser usado.
      dropPrimed();
      log(`TOCOU (${result.detail}) · ${Date.now() - started}ms desde o pedido`);
      void flushReport();
      handlers.onStart(seconds);
      timers.push(
        setTimeout(() => {
          if (token !== generation) return;
          // Acabou sozinho: não precisa mandar parar.
          nativeActive = false;
          stopPlayback(false);
          handlers.onEnd();
        }, (seconds ?? 3) * 1000 + 300)
      );
    })();
  };

  next();
}

function discard(element: HTMLVideoElement): void {
  try {
    element.pause();
  } catch {
    // já parado
  }
  element.remove();
  if (current === element) current = null;
}

/** Para o que estiver tocando. Sem nada tocando, não faz nada. */
export function stopPlayback(dropPrime = true): void {
  generation += 1;
  for (const timer of timers) clearTimeout(timer);
  timers = [];
  if (nativeActive) {
    nativeActive = false;
    void stopNative();
  }
  if (dropPrime) dropPrimed();
  const element = current;
  current = null;
  if (element) discard(element);
}

/**
 * A duração de um arquivo, sem tocar. Sem `autoplay` o player só lê o
 * cabeçalho — e isso ele faz direito. Usado ao baixar o pack.
 */
export function probeDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const element = baseElement();
    element.preload = "metadata";
    let done = false;
    const finish = (value: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      element.remove();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 4000);
    element.addEventListener("loadedmetadata", () => finish(finiteSeconds(element.duration)));
    element.addEventListener("error", () => finish(null));
    document.body.appendChild(element);
    element.src = url;
  });
}
