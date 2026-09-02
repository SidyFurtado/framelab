/**
 * O glossário que vem de fábrica.
 *
 * ── Por que existe ─────────────────────────────────────────────────
 * O glossário do editor aprende com as correções dele, mas começa
 * vazio — e o primeiro projeto paga por isso. Este aqui é o piso: o
 * vocabulário que TODO editor brasileiro usa e que o whisper erra do
 * mesmo jeito para todo mundo, porque são termos técnicos em inglês
 * ditos com sotaque português, ou marcas que o modelo nunca viu
 * escritas junto de fala em pt-BR.
 *
 * Ele entra ANTES do glossário do editor, e o do editor vence em caso
 * de conflito — quem conhece o projeto é quem está editando.
 *
 * ── Como esta lista cresce ─────────────────────────────────────────
 * A cada versão, com termo que se provou necessário: ou porque
 * apareceu nas correções que os testers relataram, ou porque falhou
 * no banco de aferição (`scripts/captions-bench.js`). Nunca por
 * palpite — termo a mais também custa, porque cada um é uma chance de
 * correção indevida.
 */

/**
 * Termos de fábrica, por família. As famílias existem para a lista
 * ser revisável por gente: dá para ver o que falta olhando um grupo.
 */
const FAMILIES: Record<string, string[]> = {
  // O que o painel faz. O editor fala esses nomes na própria narração.
  ferramentas: ["Framelab", "Premiere Pro", "After Effects", "DaVinci Resolve"],

  // Jargão de corte dito em inglês no meio da frase em português —
  // é onde o modelo mais troca a grafia.
  edicao: [
    "b-roll",
    "keyframe",
    "timeline",
    "punch in",
    "jump cut",
    "match cut",
    "cutaway",
    "rough cut",
    "Transform",
    "proxy",
    "preset",
  ],

  /*
   * Cor e imagem. Sem "look", "matiz" nem "gamma": são palavras
   * comuns demais, e o corretor as usava para reescrever texto que já
   * estava certo — visto num teste real, "Look" virando "look". Termo
   * de fábrica só entra se for inequívoco.
   */
  cor: ["LUT", "color grading", "halation"],

  // Áudio.
  audio: ["voice over", "sound design", "foley"],

  // Entrega e formato: número e sigla juntos, que o modelo adora
  // escrever por extenso.
  formato: ["4K", "1080p", "9:16", "16:9", "frame rate", "codec", "bitrate"],
};

/**
 * A lista pronta, uma linha por termo — a mesma forma que o campo do
 * painel usa, para o editor poder ler, entender e discordar.
 */
export const BASE_GLOSSARY: string = Object.values(FAMILIES)
  .flat()
  .join("\n");

/**
 * O glossário efetivo: o de fábrica embaixo, o do editor por cima.
 *
 * A ordem importa porque `parseGlossary` ordena por tamanho e o
 * corretor para no primeiro que casa: se o editor escreveu um termo
 * que também está aqui, o dele é que vale — pode ter grafia própria
 * ("Framelab" contra "FrameLab"), e a casa do projeto manda.
 */
export function effectiveGlossary(userGlossary: string): string {
  const user = userGlossary.trim();
  return user ? `${user}\n${BASE_GLOSSARY}` : BASE_GLOSSARY;
}
