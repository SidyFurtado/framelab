---
name: sound-design-intelligence
description: Professional video sound design principles, category taxonomy, layering rules, synchronization, loudness hierarchy, and anti-clutter logic.
---

# Sound Design Intelligence

Use this skill when designing sound selection algorithms, ranking audio cues, defining category hierarchies, and setting acoustic mix levels.

## 1. SFX Category Taxonomy
1. **Ambience / Beds**: Background room tone, outdoor wind, city hum, tonal drones (`-26` to `-34 dB`).
2. **Transitions & Whooshes**: Air swooshes, passes, risers and downers for camera whips, cuts, and section changes (`-12` to `-18 dB`).
3. **Impacts & Booms**: Cinematic hits, sub drops, low-end punches for key dramatic transitions (`-10` to `-14 dB`).
4. **UI & Digital**: Mechanical clicks, digital popups, subtle notification chimes, typewriter keys (`-16` to `-22 dB`).
5. **Motion Graphics & Typography**: Short snaps, whoosh-clicks, swooshes for lower thirds and title pop-ins (`-14` to `-20 dB`).
6. **Camera Dynamics**: Pressure air releases, servo zooms, whip accents (`-14` to `-18 dB`).
7. **Foley & Interaction**: Steps, rustle, physical impacts anchoring objects in the scene (`-18` to `-24 dB`).

## 2. Professional Rules of Sound Design
- **Hierarchy & Anti-Masking**: Dialogue and speech intelligibility are supreme. Never place heavy midrange SFX (1 kHz - 4 kHz) on top of critical spoken words.
- **Layering Architecture**: High-value SFX should combine 3 distinct frequencies:
  - *Low/Sub*: Weight and physical sensation (40 Hz - 100 Hz).
  - *Mid-body*: Acoustic identity and texture (200 Hz - 2 kHz).
  - *Transient Attack*: Sharp initial snap for timing accuracy (3 kHz - 10 kHz).
- **Transient Synchronization (Sync Point)**:
  - The *peak transient* of a whoosh/impact must land precisely on the visual cut/impact frame ($t_0$).
  - The *pre-roll build-up* must start $\Delta t$ before $t_0$ (e.g. 6 to 12 frames prior).
- **Density Control (Anti-Clutter)**:
  - Never trigger SFX for every single minor pixel change (avoid "Mickey Mousing").
  - Use contrast: an impactful sound is only powerful if preceded or surrounded by breathing room.

## 3. Reference Documentation & Bibliography
For theoretical background (Sonnenschein, Viers, Chion, Farnell), see [docs/TECHNICAL_BASELINE.md](file:///Users/sidyziin/Library/CloudStorage/GoogleDrive-sidycontato.f@gmail.com/Meu%20Drive/07_APPS%20E%20DEV/08_EDIT_PLUGIN/docs/TECHNICAL_BASELINE.md#4-fundamentos-conceituais-de-sound-design).
