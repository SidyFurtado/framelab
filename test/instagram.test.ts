/**
 * O endereço do Instagram, conferido fora do Premiere.
 *
 * Normalizar link é função pura e é o único ponto em que o painel
 * MEXE no que o editor colou — se errar aqui, ele consulta um vídeo e
 * baixa outro, ou pior, deixa de reconhecer o link e manda ao yt-dlp
 * um endereço que nem existe.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanInstagramUrl,
  instagramNeedsLogin,
  isInstagramUrl,
} from "../src/tools/download/instagram";

describe("isInstagramUrl", () => {
  it("olha o host, não a URL inteira", () => {
    assert.equal(isInstagramUrl("https://www.instagram.com/reel/ABC123/"), true);
    assert.equal(isInstagramUrl("https://instagram.com/p/ABC123/"), true);
    assert.equal(isInstagramUrl("https://instagr.am/p/ABC123/"), true);
    // Um encurtador que só CITA o instagram.com não é o Instagram.
    assert.equal(isInstagramUrl("https://share.example.com/?u=instagram.com/p/A"), false);
    assert.equal(isInstagramUrl("https://notinstagram.com/reel/ABC123/"), false);
    assert.equal(isInstagramUrl("https://www.tiktok.com/@a/video/1"), false);
  });
});

describe("cleanInstagramUrl", () => {
  const canonical = "https://www.instagram.com/reel/C0hQSaMpD97/";

  it("reduz as formas do mesmo reel a um endereço só", () => {
    for (const variant of [
      canonical,
      "https://www.instagram.com/reel/C0hQSaMpD97/?utm_source=ig_web_copy_link&igsh=ab12",
      "https://www.instagram.com/reels/C0hQSaMpD97/",
      "https://instagram.com/nasagoddard/reel/C0hQSaMpD97/",
      "https://www.instagram.com/reel/C0hQSaMpD97/#comentarios",
    ]) {
      assert.equal(cleanInstagramUrl(variant), canonical, variant);
    }
  });

  it("guarda o tipo do post quando ele não é reel", () => {
    assert.equal(
      cleanInstagramUrl("https://www.instagram.com/p/Dc5UrtEF9Fr/?img_index=3"),
      "https://www.instagram.com/p/Dc5UrtEF9Fr/"
    );
    assert.equal(
      cleanInstagramUrl("https://www.instagram.com/tv/ABC_123-x/"),
      "https://www.instagram.com/tv/ABC_123-x/"
    );
  });

  it("não reescreve o caminho que não é post — só tira o rastreamento", () => {
    assert.equal(
      cleanInstagramUrl("https://www.instagram.com/stories/nasa/3141592/?igshid=zz"),
      "https://www.instagram.com/stories/nasa/3141592/"
    );
    assert.equal(
      cleanInstagramUrl("https://www.instagram.com/share/reel/_AbC123/"),
      "https://www.instagram.com/share/reel/_AbC123/"
    );
    // A aba de reels do perfil não tem código: nada a canonizar.
    assert.equal(
      cleanInstagramUrl("https://www.instagram.com/nasa/reels/"),
      "https://www.instagram.com/nasa/reels/"
    );
  });

  it("deixa em paz o que não é do Instagram", () => {
    const youtube = "https://www.youtube.com/watch?v=abc123&t=30";
    assert.equal(cleanInstagramUrl(youtube), youtube);
  });
});

describe("instagramNeedsLogin", () => {
  it("só o story, que é o que falha sempre deslogado", () => {
    assert.equal(
      instagramNeedsLogin("https://www.instagram.com/stories/nasa/3141592/"),
      true
    );
    assert.equal(instagramNeedsLogin("https://www.instagram.com/reel/C0hQSaMpD97/"), false);
    assert.equal(instagramNeedsLogin("https://www.youtube.com/stories/x/"), false);
  });
});
