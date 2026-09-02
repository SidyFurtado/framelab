/**
 * O deslizador do painel — desenhado por nós, como todo o resto.
 *
 * ── Por que não o `input[type=range]` ──────────────────────────────
 * Era o último controle nativo do painel, e o único que dava valores
 * que ninguém pediu: o editor relatou cair só nos extremos ("ou 105%
 * ou 150%", "ou 16 ou 64 caracteres" — em ambos os casos, exatamente
 * o mínimo e o máximo do controle). O mesmo motivo que fez todo botão
 * daqui virar uma `div` (ver controls.ts) vale aqui: o UXP desenha e
 * conduz os controles nativos do jeito dele, e não há CSS que
 * conserte o que a condução faz.
 *
 * Aqui o valor sai de uma conta que dá para provar — a posição do
 * ponteiro dentro da pista — em vez de sair do comportamento do host.
 *
 * ── O que muda para quem usa ───────────────────────────────────────
 *   • a PISTA INTEIRA é o alvo: clicar em qualquer ponto leva o valor
 *     para lá, e já começa o arrasto. Não é preciso pegar um traço de
 *     três pixels;
 *   • DOIS CLIQUES no número abrem a digitação: quem quer exatamente
 *     25 escreve 25, em vez de caçar o passo certo;
 *   • setas andam um passo, com Shift andam dez, Home e End vão aos
 *     extremos.
 *
 * A digitação aceita vírgula decimal e ignora o sufixo — "0,7s" e
 * "17 car/s" são números para quem está lendo a tela.
 */

export interface SliderSpec {
  min: number;
  max: number;
  /** A grade em que o valor cai. A digitação também é presa a ela. */
  step: number;
  value: number;
  /** Para leitores de tela. */
  label: string;
  /** O número como o editor o lê: "42", "0,70s", "17 car/s". */
  format: (value: number) => string;
  /** Onde o número aparece — e onde os dois cliques abrem a digitação. */
  output?: HTMLElement | null;
  /** A cada passo do arrasto. */
  onInput: (value: number) => void;
  /** Ao soltar o arrasto, ou ao confirmar um número digitado. */
  onCommit?: (value: number) => void;
}

export interface SliderHandle {
  /** Põe o valor de fora — sem disparar `onInput`. */
  set(value: number): void;
  value(): number;
  /** Redesenha a partir do valor atual (rótulo mudou, por exemplo). */
  render(): void;
  destroy(): void;
}

/** Quantas casas o passo pede. `0.05` → 2. */
function decimalsOf(step: number): number {
  const text = String(step);
  if (text.includes("e-")) {
    return Number.parseInt(text.split("e-")[1] ?? "0", 10);
  }
  return (text.split(".")[1] ?? "").length;
}

export function mountSlider(host: HTMLElement, spec: SliderSpec): SliderHandle {
  const decimals = decimalsOf(spec.step);
  const span = spec.max - spec.min;
  let value = clampSnap(spec.value);

  function clampSnap(raw: number): number {
    if (!Number.isFinite(raw)) {
      return value ?? spec.min;
    }
    const held = Math.min(spec.max, Math.max(spec.min, raw));
    const stepped = spec.min + Math.round((held - spec.min) / spec.step) * spec.step;
    // Duas voltas de arredondamento: a primeira põe na grade, a
    // segunda tira o lixo de ponto flutuante que a multiplicação
    // deixa (0,30000000000000004 é um valor perfeitamente válido para
    // o computador e uma piada para quem lê).
    const clean = Number(stepped.toFixed(decimals));
    return Math.min(spec.max, Math.max(spec.min, clean));
  }

  host.className = "fl-slider";
  host.setAttribute("role", "slider");
  host.setAttribute("tabindex", "0");
  host.setAttribute("aria-label", spec.label);
  host.innerHTML =
    '<span class="fl-slider-line"></span>' +
    '<span class="fl-slider-fill"></span>' +
    '<span class="fl-slider-thumb"></span>';

  const fill = host.querySelector<HTMLElement>(".fl-slider-fill");
  const thumb = host.querySelector<HTMLElement>(".fl-slider-thumb");

  function render(): void {
    const percent = span === 0 ? 0 : ((value - spec.min) / span) * 100;
    if (fill) fill.style.width = `${percent}%`;
    if (thumb) thumb.style.left = `${percent}%`;
    host.setAttribute("aria-valuenow", String(value));
    host.setAttribute("aria-valuemin", String(spec.min));
    host.setAttribute("aria-valuemax", String(spec.max));
    host.setAttribute("aria-valuetext", spec.format(value));
    if (spec.output && !editing) {
      spec.output.textContent = spec.format(value);
    }
  }

  /** Move o valor e avisa — só quando ele de fato mudou. */
  function apply(next: number, commit: boolean): void {
    const settled = clampSnap(next);
    const changed = settled !== value;
    value = settled;
    render();
    if (changed) {
      spec.onInput(value);
    }
    if (commit) {
      spec.onCommit?.(value);
    }
  }

  function valueAt(clientX: number): number {
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0) {
      return value;
    }
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return spec.min + ratio * span;
  }

  // ── arrasto ───────────────────────────────────────────────────
  // Os ouvintes de movimento vivem no `document` e não no elemento:
  // o ponteiro sai da pista o tempo todo num painel de 320px, e um
  // arrasto que morre ao encostar na borda é pior que não arrastar.

  let dragging = false;

  const onMove = (event: MouseEvent): void => {
    if (!dragging) return;
    event.preventDefault();
    apply(valueAt(event.clientX), false);
  };

  const onUp = (event: MouseEvent): void => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    apply(valueAt(event.clientX), true);
  };

  const onDown = (event: MouseEvent): void => {
    // Só o botão principal: o secundário abre menu de contexto.
    if (event.button !== 0) return;
    event.preventDefault();
    host.focus();
    dragging = true;
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    apply(valueAt(event.clientX), false);
  };

  const onKey = (event: KeyboardEvent): void => {
    const jump = event.shiftKey ? spec.step * 10 : spec.step;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown": next = value - jump; break;
      case "ArrowRight":
      case "ArrowUp": next = value + jump; break;
      case "Home": next = spec.min; break;
      case "End": next = spec.max; break;
      case "Enter":
      case " ": openEntry(); event.preventDefault(); return;
      default: return;
    }
    event.preventDefault();
    apply(next, true);
  };

  host.addEventListener("mousedown", onDown);
  host.addEventListener("keydown", onKey);

  // ── digitar o número ──────────────────────────────────────────

  let editing = false;
  let entry: HTMLInputElement | null = null;

  /**
   * "0,7s" e "17 car/s" são números para quem lê a tela.
   *
   * A vírgula é o separador decimal aqui, e o sufixo é do rótulo, não
   * do valor — exigir que o editor apague o "s" seria transformar uma
   * conveniência em pegadinha.
   */
  function parseTyped(text: string): number {
    const cleaned = text.replace(/,/g, ".").replace(/[^0-9.\-]/g, "");
    return Number.parseFloat(cleaned);
  }

  function closeEntry(commit: boolean): void {
    if (!editing || !entry || !spec.output) return;
    const typed = commit ? parseTyped(entry.value) : Number.NaN;
    editing = false;
    entry = null;
    spec.output.textContent = spec.format(value);
    if (Number.isFinite(typed)) {
      apply(typed, true);
    }
    render();
  }

  function openEntry(): void {
    if (editing || !spec.output) return;
    editing = true;
    spec.output.textContent = "";
    const field = document.createElement("input");
    field.type = "text";
    field.className = "fl-slider-entry";
    // O número cru, sem o sufixo: é o que se quer editar.
    field.value = String(value);
    field.setAttribute("aria-label", spec.label);
    spec.output.appendChild(field);
    entry = field;
    field.focus();
    field.select();

    field.addEventListener("keydown", (event) => {
      /*
       * Nada do que se digita aqui sobe para o número.
       *
       * O elemento do número também escuta teclado — é o que deixa
       * abrir a digitação sem mouse. Só que o campo mora DENTRO dele:
       * o Enter que confirma subia até esse ouvinte, que reabria a
       * digitação em seguida. O valor entrava certo e a tela ficava
       * com o rótulo vazio e um campo pendurado. O Espaço tinha o
       * mesmo caminho, e não daria para digitar espaço nenhum.
       */
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        closeEntry(true);
        host.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeEntry(false);
        host.focus();
      }
    });
    // Sair do campo confirma: clicar fora para "cancelar" não é o que
    // ninguém espera de um campo de número.
    field.addEventListener("blur", () => closeEntry(true));
  }

  const onOutputDouble = (): void => openEntry();
  const onOutputKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openEntry();
    }
  };

  if (spec.output) {
    spec.output.classList.add("is-typable");
    spec.output.setAttribute("tabindex", "0");
    spec.output.setAttribute("title", "Dois cliques para digitar o valor");
    spec.output.addEventListener("dblclick", onOutputDouble);
    spec.output.addEventListener("keydown", onOutputKey);
  }

  render();

  return {
    set(next: number): void {
      value = clampSnap(next);
      render();
    },
    value: () => value,
    render,
    destroy(): void {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      host.removeEventListener("mousedown", onDown);
      host.removeEventListener("keydown", onKey);
      if (spec.output) {
        spec.output.removeEventListener("dblclick", onOutputDouble);
        spec.output.removeEventListener("keydown", onOutputKey);
      }
    },
  };
}
