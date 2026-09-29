import { createToolSettings, pickString, warmToolSettings } from "../../bridge/settings";
import { DEFAULT_PACK_ID, folderIdFrom, LEGACY_PACK_ID } from "./pack";

export interface SfxSettings {
  pack: string;
  view: string;
  favorites: string[];
  folder: string;
  folderToken: string;
}

export const SFX_DEFAULTS: SfxSettings = {
  pack: DEFAULT_PACK_ID, view: "inicio", favorites: [], folder: "", folderToken: "",
};

/** One settings instance for the library and automatic sound design. */
export const sfxSettings = createToolSettings<SfxSettings>("sfx-config.json", SFX_DEFAULTS, (raw) => ({
  // O pack antigo (221 sons) está dentro do grande: quem o tinha salvo passa para o grande.
  pack: ((id) => (id === LEGACY_PACK_ID ? DEFAULT_PACK_ID : id))(folderIdFrom(pickString(raw.pack, DEFAULT_PACK_ID)) ?? DEFAULT_PACK_ID),
  view: pickString(raw.view, "inicio"),
  favorites: Array.isArray(raw.favorites)
    ? raw.favorites.filter((item): item is string => typeof item === "string").slice(0, 500) : [],
  folder: typeof raw.folder === "string" ? raw.folder : "",
  folderToken: typeof raw.folderToken === "string" ? raw.folderToken : "",
}));

warmToolSettings(sfxSettings);
