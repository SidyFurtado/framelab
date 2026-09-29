/**
 * O cursor da busca do SFX, protegido do redesenho da lista.
 *
 * ── O defeito ─────────────────────────────────────────────────
 * Redesenhar a lista troca a árvore do corpo por `innerHTML`. O UXP
 * reage reaplicando o foco no campo, e um campo de texto do UXP que
 * RECEBE foco seleciona todo o conteúdo. Para quem digita: "Clic", uma
 * pausa, a lista se redesenha, o texto fica todo selecionado, e o "k"
 * substitui tudo.
 *
 * ── Por que a primeira correção voltou a falhar ───────────────
 * Ela lia o cursor antes do redesenho e conferia logo depois, no mesmo
 * instante. Só que o UXP seleciona o texto DEPOIS, quando refaz o
 * layout — na hora da conferência nada tinha mudado, e a seleção
 * chegava quando ninguém mais olhava.
 *
 * ── O que esta guarda faz ─────────────────────────────────────
 * 1. Lembra onde o editor deixou o cursor: a cada letra, e ao fim de
 *    cada gesto de seleção dele (mouse, setas, Cmd+A).
 * 2. Depois de cada redesenho, confere agora e de novo nos quadros
 *    seguintes; se o texto ficou todo selecionado sem ele pedir,
 *    devolve o cursor.
 * 3. Se uma tecla chega com o texto todo selecionado e não foi o
 *    editor quem selecionou, o cursor volta ao lugar ANTES de a tecla
 *    agir — onde o UXP entrega o keydown a tempo.
 * 4. Digitando rápido, a tecla chega antes das conferências, e o UXP
 *    entrega o keydown ao JS depois de o campo já ter trocado o texto.
 *    Então o `input` confere o resultado: se "Clic" virou "k" e nenhuma
 *    edição de verdade no cursor dá "k" (ver `repairReplacement`), a
 *    busca é remontada como "Click", com o cursor depois do "k".
 *
 * Seleção que o editor fez (Cmd+A, duplo clique, arrasto) é dele e
 * fica como está.
 */

export interface Caret {
  value: string;
  start: number;
  end: number;
}

/** O pedaço do campo que a guarda usa — um <input> serve. */
export interface CaretField {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange?: (start: number, end: number) => void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export interface CaretGuardHost {
  /** Quem tem o foco agora — `document.activeElement` no painel. */
  activeElement: () => unknown;
  /** Agenda uma conferência para depois; o padrão é `setTimeout`. */
  later?: (run: () => void, ms: number) => void;
}

export interface CaretGuard {
  /** Roda o redesenho e devolve o cursor, agora e nos quadros seguintes. */
  around(paint: () => void): void;
  /** O código mudou o texto do campo (limpar, Esc): esse é o novo ponto de partida. */
  sync(): void;
  /** O que a guarda lembra — para os testes. */
  remembered(): Caret | null;
}

/** Conferências depois do redesenho: já, no próximo giro e após o layout. */
const LATE_CHECKS_MS = [0, 16, 50, 120];

const NAVIGATION = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

function isWhole(caret: Caret): boolean {
  return caret.value.length > 0 && caret.start === 0 && caret.end === caret.value.length;
}

/** Letra ou número — o que o Option+Delete trata como parte de palavra. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Entre `left` e `right` há fronteira de palavra (ou uma ponta do texto). */
function atWordEdge(left: string, right: string): boolean {
  return left === "" || right === "" || !WORD_CHAR.test(left.slice(-1)) || !WORD_CHAR.test(right[0]);
}

/**
 * O texto `value` pode ter saído de uma edição de verdade no cursor
 * (ou na seleção) de `prev`? Digitar e colar mantêm o que está antes e
 * depois do cursor; apagar tira um caractere, ou uma palavra inteira
 * (Option+Delete), ou tudo até a ponta (Cmd+Delete).
 */
function couldBeEdit(prev: Caret, value: string): boolean {
  const old = prev.value;
  const pre = old.slice(0, prev.start);
  const post = old.slice(prev.end);
  // Digitar, colar ou apagar o que estava selecionado.
  if (value.length >= pre.length + post.length && value.startsWith(pre) && value.endsWith(post)) return true;
  if (prev.start !== prev.end) return false;

  // Backspace: some um pedaço que termina no cursor.
  if (value.endsWith(post)) {
    const kept = value.slice(0, value.length - post.length);
    if (pre.startsWith(kept)) {
      const removed = pre.slice(kept.length);
      if (removed.length === 1 || atWordEdge(kept, removed)) return true;
    }
  }
  // Delete para a frente: some um pedaço que começa no cursor.
  if (value.startsWith(pre)) {
    const kept = value.slice(pre.length);
    const rest = old.slice(pre.length);
    if (rest.endsWith(kept)) {
      const removed = rest.slice(0, rest.length - kept.length);
      if (removed.length === 1 || atWordEdge(removed, kept)) return true;
    }
  }
  return false;
}

/**
 * Se o texto inteiro foi trocado pelo que o editor acabou de digitar —
 * sinal de que o UXP tinha selecionado tudo sozinho —, devolve a busca
 * como ficaria com as letras no cursor. `null` = edição normal, ou não
 * dá para saber (campo vazio, por exemplo: pode ter sido Cmd+Delete).
 */
export function repairReplacement(prev: Caret, value: string): Caret | null {
  if (!prev.value || isWhole(prev) || value === "" || value === prev.value) return null;
  if (couldBeEdit(prev, value)) return null;
  const pre = prev.value.slice(0, prev.start);
  const post = prev.value.slice(prev.end);
  const at = pre.length + value.length;
  return { value: pre + value + post, start: at, end: at };
}

export function guardCaret(field: CaretField, host: CaretGuardHost): CaretGuard {
  const later = host.later ?? ((run, ms) => void setTimeout(run, ms));
  let focused = false;
  let last: Caret | null = null;
  // Cmd+Z troca o texto por outro qualquer: não é caso de remontar.
  let undoing = false;

  const hasFocus = (): boolean => focused || host.activeElement() === field;

  function read(): Caret | null {
    const start = field.selectionStart;
    if (start === null || start === undefined) return null;
    return { value: field.value, start, end: field.selectionEnd ?? start };
  }

  function remember(): void {
    const now = read();
    if (now) last = now;
  }

  function place(caret: Caret): void {
    if (typeof field.setSelectionRange === "function") {
      field.setSelectionRange(caret.start, caret.end);
    } else {
      field.selectionStart = caret.start;
      field.selectionEnd = caret.end;
    }
  }

  /**
   * Devolve o cursor se o texto ficou todo selecionado sem o editor
   * pedir. Qualquer outra diferença é dele (ou de uma letra que ainda
   * não chegou ao `input`) e fica.
   */
  function restore(): void {
    if (!last || !hasFocus()) return;
    const now = read();
    if (!now || now.value !== last.value) return;
    if (!isWhole(now) || isWhole(last)) return;
    place(last);
  }

  field.addEventListener("focus", () => {
    focused = true;
  });
  field.addEventListener("blur", () => {
    focused = false;
  });
  field.addEventListener("input", () => {
    const prev = last;
    const now = read();
    if (!now) return;
    const fixed = prev && !undoing ? repairReplacement(prev, now.value) : null;
    undoing = false;
    if (fixed) {
      field.value = fixed.value;
      place(fixed);
      last = fixed;
    } else {
      last = now;
    }
  });
  field.addEventListener("mouseup", remember);
  field.addEventListener("dblclick", remember);
  field.addEventListener("keyup", (event: KeyboardEvent) => {
    // Letras já são lembradas pelo `input`. Aqui entram só os gestos
    // que mexem no cursor sem mudar o texto — senão um keyup atrasado
    // gravaria a seleção falsa como se fosse do editor.
    const selectAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a";
    if (selectAll || NAVIGATION.has(event.key)) remember();
  });
  field.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") undoing = true;
      // Cmd+A já vale no keydown: se a letra seguinte chegar antes de
      // soltar o A, ela substitui tudo, como o editor pediu.
      if (key === "a") last = { value: field.value, start: 0, end: field.value.length };
      return;
    }
    if (event.altKey) return;
    const types = event.key.length === 1 || event.key === "Backspace" || event.key === "Delete";
    if (!types) return;
    restore();
  });

  return {
    around(paint) {
      // Antes do redesenho o cursor é o do editor — salvo se já está
      // tudo selecionado, que aí vale o que ele deixou por último.
      const before = hasFocus() ? read() : null;
      if (before && (!isWhole(before) || !last)) last = before;
      paint();
      restore();
      for (const ms of LATE_CHECKS_MS) later(restore, ms);
    },
    sync() {
      undoing = false;
      last = { value: field.value, start: field.value.length, end: field.value.length };
    },
    remembered: () => last,
  };
}
