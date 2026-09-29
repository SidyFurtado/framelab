/**
 * Um botão que abre uma lista de opções.
 *
 * Nasceu no Baixar Vídeos e mora aqui porque a segunda ferramenta a
 * precisar dele provou que é vocabulário do painel, não de uma
 * ferramenta: a alternativa — uma barra de segmentos com muitos
 * degraus — enche a tela para responder uma pergunta que se responde
 * uma vez. Fechado ocupa uma linha e diz a escolha; aberto mostra a
 * informação que de fato decide.
 *
 * Também resolve listas longas: o UXP não honra `flex-wrap`, então uma
 * fila de dez idiomas não quebraria linha — espremeria todos até
 * ninguém conseguir ler.
 *
 * ── Busca ─────────────────────────────────────────────────────────
 * Opcional, e existe por uma lista concreta: as fontes instaladas na
 * máquina são quase trezentas, e rolar até "Poppins-Black" é pior que
 * digitar "popp". Com `search`, o menu ganha um campo no topo que
 * filtra enquanto se escreve; Enter escolhe o primeiro da lista.
 *
 * Quando `search.useTyped` existe, o que foi digitado também pode ser
 * aceito COMO VALOR — é o que permite mandar uma fonte cujo nome de
 * arquivo não é o nome PostScript, sem transformar o campo inteiro
 * numa caixa de texto onde todo mundo erra.
 */
import { CONTROL, escapeHtml } from "./controls";

export interface MenuOption {
  readonly id: string;
  readonly label: string;
  /** Direita da linha: tamanho, resolução. Vazio some. */
  readonly meta?: string;
}

export interface MenuSearch {
  /** Texto de ajuda dentro do campo. */
  readonly placeholder: string;
  /**
   * Rótulo da linha que aceita o texto digitado como valor.
   *
   * Ausente: o que não está na lista não pode ser escolhido.
   */
  readonly useTyped?: (query: string) => string;
}

export interface Dropdown {
  /** Relê as opções e o selecionado. */
  render(): void;
  /** Fecha, a menos que o clique tenha sido dentro dele. */
  closeUnless(target: Element | null): void;
}

/** Sem acento e sem caixa: "Ação" acha por "acao". */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * As opções que casam com a busca, as que começam com ela primeiro.
 *
 * Quem digita "mont" quer "Montserrat-Bold" antes de
 * "DemoMontserrat" — e a ordem original é preservada dentro de cada
 * grupo, porque ela já era significativa (a opção de fábrica no topo).
 */
export function filterOptions(
  options: readonly MenuOption[],
  query: string
): MenuOption[] {
  const needle = fold(query.trim());
  if (!needle) {
    return [...options];
  }
  const starts: MenuOption[] = [];
  const contains: MenuOption[] = [];
  for (const option of options) {
    const label = fold(option.label);
    if (label.startsWith(needle)) {
      starts.push(option);
    } else if (label.includes(needle) || fold(option.meta ?? "").includes(needle)) {
      contains.push(option);
    }
  }
  return [...starts, ...contains];
}

export function mountDropdown(
  host: HTMLElement,
  source: {
    options(): MenuOption[];
    selected(): string;
    onPick(id: string): void;
    /** Campo de busca no topo do menu. Ausente = sem busca. */
    readonly search?: MenuSearch;
  }
): Dropdown {
  const search = source.search;
  host.className = "dl-pick-wrap";
  host.innerHTML =
    `<div class="dl-pick" ${CONTROL} data-pick-button aria-expanded="false">` +
      '<span class="dl-pick-value" data-pick-value></span>' +
      '<span class="dl-pick-meta" data-pick-meta></span>' +
      '<span class="dl-pick-caret" aria-hidden="true">▾</span>' +
    "</div>" +
    '<div class="dl-menu" data-pick-menu hidden>' +
      (search
        ? '<input type="text" class="dl-menu-search" data-pick-search spellcheck="false" ' +
          // Busca de menu não é formulário: sem histórico nem correção.
          'autocomplete="off" autocorrect="off" autocapitalize="off" ' +
          `placeholder="${escapeHtml(search.placeholder)}">`
        : "") +
      // A lista é um nó SEPARADO do campo: `render()` reescreve só ela,
      // e o que já foi digitado sobrevive a cada filtragem.
      '<div data-pick-list></div>' +
    "</div>";

  const button = host.querySelector<HTMLElement>("[data-pick-button]")!;
  const valueEl = host.querySelector<HTMLElement>("[data-pick-value]")!;
  const metaEl = host.querySelector<HTMLElement>("[data-pick-meta]")!;
  const menu = host.querySelector<HTMLElement>("[data-pick-menu]")!;
  const list = host.querySelector<HTMLElement>("[data-pick-list]")!;
  const searchEl = host.querySelector<HTMLInputElement>("[data-pick-search]");

  function query(): string {
    return searchEl?.value ?? "";
  }

  function setOpen(open: boolean): void {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      // Abrir com a busca limpa: a lista inteira é a resposta certa
      // para quem acabou de clicar, e o filtro de ontem não é.
      if (searchEl) {
        searchEl.value = "";
      }
      render();
      // O foco vai para o campo, senão "clico e digito" exige um
      // segundo clique que ninguém adivinha.
      try {
        searchEl?.focus();
      } catch {
        /* build sem foco programático: a busca ainda funciona no clique */
      }
    }
  }

  function render(): void {
    const options = source.options();
    const selected = source.selected();
    const current = options.find((option) => option.id === selected);

    // Valor escolhido que não está na lista — uma fonte digitada, por
    // exemplo — ainda tem de aparecer no botão.
    valueEl.textContent = current?.label ?? (selected ? selected : "—");
    metaEl.textContent = current?.meta ?? "";

    const visible = filterOptions(options, query());
    const typed = query().trim();
    const rows = visible
      .map(
        (option) =>
          `<div class="dl-menu-item" ${CONTROL} data-value="${escapeHtml(option.id)}" ` +
          `aria-pressed="${option.id === selected}">` +
          `<span class="dl-menu-name">${escapeHtml(option.label)}</span>` +
          `<span class="dl-menu-meta">${escapeHtml(option.meta ?? "")}</span>` +
          "</div>"
      )
      .join("");

    const extra =
      search?.useTyped && typed && !visible.some((option) => option.id === typed)
        ? `<div class="dl-menu-item is-typed" ${CONTROL} data-raw="${escapeHtml(typed)}">` +
          `<span class="dl-menu-name">${escapeHtml(search.useTyped(typed))}</span>` +
          "</div>"
        : "";

    list.innerHTML =
      rows || extra
        ? rows + extra
        : '<div class="dl-menu-empty">nada com esse nome</div>';
  }

  button.addEventListener("click", () => setOpen(menu.hidden));

  menu.addEventListener("click", (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>(
      "[data-value],[data-raw]"
    );
    if (!item) return;
    const id = item.dataset.value ?? item.dataset.raw;
    // `data-value` vazio é opção legítima ("a do modelo"); só a
    // ausência das duas chaves não é escolha.
    if (id === undefined) return;
    setOpen(false);
    source.onPick(id);
  });

  searchEl?.addEventListener("input", render);

  searchEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      // Enter escolhe o primeiro da lista filtrada — o gesto de quem
      // digitou "popp" para chegar em Poppins-Black.
      const first = list.querySelector<HTMLElement>("[data-value],[data-raw]");
      const id = first?.dataset.value ?? first?.dataset.raw;
      if (id !== undefined) {
        setOpen(false);
        source.onPick(id);
      }
      event.preventDefault();
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  });

  render();

  return {
    render,
    closeUnless(target) {
      if (!menu.hidden && !host.contains(target)) {
        setOpen(false);
      }
    },
  };
}
