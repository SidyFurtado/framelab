/**
 * A busca do menu — a parte que decide o que aparece.
 *
 * O resto do dropdown é DOM e host; o filtro é função pura, e é ele
 * que faz "popp" chegar em Poppins-Black em vez de rolar 277 linhas.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterOptions, type MenuOption } from "../src/shell/dropdown";

const FONTS: MenuOption[] = [
  { id: "", label: "A do modelo", meta: "Mytupi-Bold" },
  { id: "Anton-Regular", label: "Anton-Regular" },
  { id: "DemoMontserrat", label: "DemoMontserrat" },
  { id: "Montserrat-Black", label: "Montserrat-Black" },
  { id: "Montserrat-Bold", label: "Montserrat-Bold" },
  { id: "Poppins-Black", label: "Poppins-Black" },
  { id: "Ação-Regular", label: "Ação-Regular" },
];

describe("filterOptions", () => {
  it("sem busca, devolve tudo na ordem original", () => {
    assert.deepEqual(filterOptions(FONTS, "").map((o) => o.id), FONTS.map((o) => o.id));
    assert.equal(filterOptions(FONTS, "   ").length, FONTS.length);
  });

  it("quem COMEÇA com o texto vem antes de quem só contém", () => {
    assert.deepEqual(
      filterOptions(FONTS, "mont").map((o) => o.id),
      ["Montserrat-Black", "Montserrat-Bold", "DemoMontserrat"]
    );
  });

  it("acha sem depender de caixa nem de acento", () => {
    assert.deepEqual(filterOptions(FONTS, "POPP").map((o) => o.id), ["Poppins-Black"]);
    assert.deepEqual(filterOptions(FONTS, "acao").map((o) => o.id), ["Ação-Regular"]);
  });

  it("acha também pelo meta — é como a fonte do modelo aparece", () => {
    assert.deepEqual(filterOptions(FONTS, "mytupi").map((o) => o.id), [""]);
  });

  it("nada com esse nome devolve lista vazia, não a lista inteira", () => {
    assert.deepEqual(filterOptions(FONTS, "zzz"), []);
  });
});
