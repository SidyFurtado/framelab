/**
 * Os idiomas da tradução.
 *
 * Lista maior que a das Legendas de propósito: transcrever depende do
 * modelo baixado, traduzir não — o serviço aceita qualquer par, e
 * limitar a doze seria inventar uma restrição que não existe.
 *
 * "Detectar" só existe na ORIGEM. Como destino não faz sentido, e a
 * lista de destino não o tem — em vez de deixá-lo lá e recusar depois.
 */
export interface TransLanguage {
  id: string;
  label: string;
}

export const TARGET_LANGUAGES: readonly TransLanguage[] = [
  { id: "pt", label: "Português" },
  { id: "en", label: "Inglês" },
  { id: "es", label: "Espanhol" },
  { id: "fr", label: "Francês" },
  { id: "it", label: "Italiano" },
  { id: "de", label: "Alemão" },
  { id: "nl", label: "Holandês" },
  { id: "pl", label: "Polonês" },
  { id: "ru", label: "Russo" },
  { id: "tr", label: "Turco" },
  { id: "ar", label: "Árabe" },
  { id: "hi", label: "Híndi" },
  { id: "id", label: "Indonésio" },
  { id: "ja", label: "Japonês" },
  { id: "ko", label: "Coreano" },
  { id: "zh", label: "Chinês" },
];

export const SOURCE_LANGUAGES: readonly TransLanguage[] = [
  { id: "auto", label: "Detectar" },
  ...TARGET_LANGUAGES,
];

/** O rótulo de um código, sem mentir quando não conhece. */
export function labelOf(id: string | null | undefined): string {
  if (!id) return "—";
  const achado = SOURCE_LANGUAGES.find((l) => l.id === id);
  return achado?.label ?? id.toUpperCase();
}
