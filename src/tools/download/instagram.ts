/**
 * Instagram — o que o link precisa antes de virar download.
 *
 * ── Por que não há via rápida aqui ─────────────────────────────────
 * O TikTok tem uma API de terceiro que devolve o MP4 do CDN em um
 * segundo, e por isso tiktok.ts existe. O Instagram não tem
 * equivalente confiável: os sites que prometem isso raspam a mesma
 * página que o yt-dlp já raspa, só que atrás de um servidor que pode
 * sumir amanhã. Medido num Reel público: o yt-dlp resolve sem login,
 * em segundos, pelo caminho que o painel já usa para o YouTube. Não
 * há atalho a ganhar — há só um terceiro a depender.
 *
 * O que sobra para este módulo é o link em si. O endereço que o
 * aplicativo copia vem com rastreamento colado (`?igsh=…`), às vezes
 * com o perfil no meio do caminho (`/nasagoddard/reel/…`) e às vezes
 * no plural (`/reels/…`). Tudo isso o extractor até aceita, mas é o
 * texto que o painel guarda, mostra na lista e compara entre duas
 * linhas coladas — e dois endereços diferentes do MESMO vídeo viravam
 * dois downloads.
 */

/** Host do Instagram — e só o host, como em tiktok.ts. */
export function isInstagramUrl(url: string): boolean {
  const host = url.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0];
  return /(^|\.)(instagram\.com|instagr\.am)$/i.test(host);
}

/**
 * O post, o reel ou o IGTV, onde quer que ele esteja no caminho.
 *
 * O perfil antes do tipo é opcional porque o botão "copiar link" do
 * aplicativo ora o inclui, ora não.
 */
const SHORTCODE = /\/(reels?|p|tv)\/([A-Za-z0-9_-]+)/i;

/** O que o Instagram cola no fim do endereço e não significa nada. */
const TRACKING = /^(igsh|igshid|img_index|hl|fbclid|utm_[a-z_]+|ig_[a-z_]+)$/i;

/**
 * O mesmo vídeo, sempre escrito do mesmo jeito.
 *
 * Endereço que não é de post — story, destaque, `/share/`, perfil —
 * fica como está, menos o rastreamento: o caminho ali carrega
 * informação que o extractor usa, e reescrevê-lo por palpite seria
 * quebrar o que hoje funciona.
 */
export function cleanInstagramUrl(url: string): string {
  if (!isInstagramUrl(url)) {
    return url;
  }
  const noHash = url.split("#", 1)[0];
  const cut = noHash.indexOf("?");
  const path = cut === -1 ? noHash : noHash.slice(0, cut);
  const query = cut === -1 ? "" : noHash.slice(cut + 1);

  // `/share/reel/<código>` tem a cara de um reel e NÃO é: aquele código
  // é do redirecionamento, não do post. Canonizá-lo montava um endereço
  // de reel que não existe — e o painel trocava um link que funcionava
  // por um 404.
  const match = /\/share\//i.test(path) ? null : SHORTCODE.exec(path);
  if (match) {
    const kind = match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase();
    return `https://www.instagram.com/${kind}/${match[2]}/`;
  }

  const kept = query
    .split("&")
    .filter((pair) => pair.length > 0 && !TRACKING.test(pair.split("=", 1)[0]));
  return kept.length > 0 ? `${path}?${kept.join("&")}` : path;
}

/**
 * Link que o Instagram NUNCA entrega deslogado.
 *
 * Reel e post públicos vêm sem cookie nenhum — avisar sobre login em
 * todos seria barulho na maioria absoluta dos casos. Story e destaque
 * são a exceção real: sem os cookies do navegador eles falham sempre,
 * e o painel prefere dizer isso antes da falha.
 */
export function instagramNeedsLogin(url: string): boolean {
  return isInstagramUrl(url) && /\/stories\//i.test(url);
}
