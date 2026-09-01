/**
 * The contract between the Product Shell and a Tool.
 *
 * The Shell owns the top bar, the navigator, the workspace header, the
 * selection strip, the action bar and the status bar. A Tool owns only
 * the body between the callout and the action bar.
 */
export interface ToolContext {
  setApplyLabel(label: string): void;
  setApplyEnabled(enabled: boolean): void;
  setApplyHandler(handler: (() => void | Promise<void>) | null): void;
  /** Wires the secondary action. null hides it. */
  setResetHandler(handler: (() => void) | null): void;
  setResetLabel(label: string): void;
  setStatus(text: string, tone?: StatusTone): void;
  /** Asks the Shell to re-read the timeline selection. */
  refreshSelection(): void;
  /**
   * Wires the Tool into the Shell's selection refresh: the Shell calls
   * this handler every time it re-reads the timeline, so a Tool that
   * caches something about the selection can re-read it too. null
   * detaches. Without it a Tool that scans once at mount goes stale the
   * moment the editor clicks a different clip.
   */
  setRefreshHandler(handler: (() => void) | null): void;
}

export type StatusTone = "idle" | "done" | "error";

export interface Tool {
  readonly id: string;
  readonly name: string;
  /** One line, shown under the name in the navigator. */
  readonly summary: string;
  /** Sentence shown in the workspace callout. */
  readonly hint: string;
  readonly category: string;
  /** Key into the glyph set drawn in the navigator. */
  readonly glyph: string;
  /** false renders the Tool in the navigator but blocks the workspace. */
  readonly available: boolean;
  /**
   * false quando a Tool não age sobre a seleção da timeline.
   *
   * A Shell carimba a contagem de clipes no botão Aplicar, e num botão
   * que diz BAIXAR esse selo mentia: o download não tem nada a ver com
   * o que está selecionado. Ausente vale true, que é o caso de todas
   * as Tools que agem na timeline.
   */
  readonly usesSelection?: boolean;
  mount(container: HTMLElement, context: ToolContext): void;
  /**
   * Released before another Tool is mounted. The Shell replaces the body
   * markup on its own, so this is only for what outlives it: listeners
   * on window or document, timers, host subscriptions.
   */
  unmount?(): void;
}

export interface Category {
  readonly id: string;
  readonly name: string;
}
