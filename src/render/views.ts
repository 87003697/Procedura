/**
 * Shared catalog of named camera angles for the refine render loop.
 *
 * The refine model multi-selects which of these it wants on each `render_views`
 * call (it decides *which* views and *how many*, 1..N). Each entry is a camera
 * DIRECTION (object → camera, Blender Z-up): the camera sits along this vector
 * and looks back at the model's centre. The actual direction vectors live in
 * the Blender scripts; this module owns the names, projection (ortho vs
 * perspective), grouping, and the human-facing descriptions used to build the
 * tool menu.
 *
 * KEEP IN SYNC with `all_angles` / `ortho_views` in:
 *   - scripts/_render_ao_blender.py
 *   - scripts/_render_parts_color_blender.py
 * Those run inside Blender's embedded Python and cannot import this module, so
 * the direction vectors are duplicated there. The set of names and the ortho
 * flags MUST match this catalog.
 */

export const VIEW_CATALOG = [
  // ── 6 orthographic faces (tight AABB fit, parallel edges stay parallel) ──
  { name: "front",  group: "face", ortho: true,  desc: "front face (−Y)" },
  { name: "back",   group: "face", ortho: true,  desc: "back face (+Y)" },
  { name: "left",   group: "face", ortho: true,  desc: "left face (−X)" },
  { name: "right",  group: "face", ortho: true,  desc: "right face (+X)" },
  { name: "top",    group: "face", ortho: true,  desc: "top (+Z), looking straight down" },
  { name: "bottom", group: "face", ortho: true,  desc: "bottom (−Z), looking straight up" },

  // ── 8 isometric corners (perspective 3/4 hero shots) ──
  { name: "isometric",  group: "corner", ortho: false, desc: "front-right-top 3/4 hero (the default)" },
  { name: "iso-FL-top", group: "corner", ortho: false, desc: "front-left-top 3/4" },
  { name: "iso-BR-top", group: "corner", ortho: false, desc: "back-right-top 3/4" },
  { name: "iso-BL-top", group: "corner", ortho: false, desc: "back-left-top 3/4" },
  { name: "iso-FR-bot", group: "corner", ortho: false, desc: "front-right-bottom 3/4 (underside)" },
  { name: "iso-FL-bot", group: "corner", ortho: false, desc: "front-left-bottom 3/4 (underside)" },
  { name: "iso-BR-bot", group: "corner", ortho: false, desc: "back-right-bottom 3/4 (underside)" },
  { name: "iso-BL-bot", group: "corner", ortho: false, desc: "back-left-bottom 3/4 (underside)" },

  // ── 4 eye-level diagonals (two adjacent faces, no vertical tilt) ──
  { name: "front-right", group: "diagonal", ortho: false, desc: "eye level, between front & right" },
  { name: "front-left",  group: "diagonal", ortho: false, desc: "eye level, between front & left" },
  { name: "back-right",  group: "diagonal", ortho: false, desc: "eye level, between back & right" },
  { name: "back-left",   group: "diagonal", ortho: false, desc: "eye level, between back & left" },

  // ── 2 hero tilts (front, tilted ~15° below / above the horizon) ──
  { name: "front-low",  group: "tilt", ortho: false, desc: "front from ~15° below (looking up)" },
  { name: "front-high", group: "tilt", ortho: false, desc: "front from ~15° above (looking down)" },
] as const;

export type ViewSpec = (typeof VIEW_CATALOG)[number];
export type ViewName = ViewSpec["name"];

export const ALL_VIEW_NAMES: readonly ViewName[] = VIEW_CATALOG.map((v) => v.name);
const VIEW_NAME_SET = new Set<string>(ALL_VIEW_NAMES);

/**
 * Forgiving aliases → canonical names. The front-right-top hero corner is
 * named "isometric" (kept stable so the default render's `ao-isometric.png`
 * filenames don't change), but the other 7 corners follow an `iso-XX-yyy`
 * pattern — so a model will plausibly ask for "iso-FR-top". Map those back
 * rather than rejecting them.
 */
const VIEW_ALIASES: Record<string, ViewName> = {
  "iso-FR-top": "isometric",
  iso: "isometric",
};

/**
 * The default view set used when the model does not multi-select (and for the
 * draft / final-preview renders that aren't model-driven). Matches the
 * historical 4-view behaviour: hero iso + 3 ortho elevations.
 */
export const DEFAULT_VIEWS = ["isometric", "front", "right", "top"] as const;

export function isKnownView(name: string): boolean {
  return VIEW_NAME_SET.has(name);
}

/**
 * Normalise a model-requested view list: trim, keep only known names, dedupe,
 * and emit them in CATALOG order so render order and `ao-<name>.png` filenames
 * are deterministic. If nothing valid remains, fall back to {@link DEFAULT_VIEWS}.
 * Unknown names are returned separately so the caller can warn the model
 * (rather than silently dropping them).
 */
export function resolveViews(requested: readonly string[] | undefined): {
  views: ViewName[];
  unknown: string[];
} {
  if (requested === undefined || requested.length === 0) {
    return { views: [...DEFAULT_VIEWS], unknown: [] };
  }
  const want = new Set<string>();
  const unknown: string[] = [];
  for (const raw of requested) {
    const n0 = String(raw).trim();
    if (n0 === "") continue;
    const n = VIEW_ALIASES[n0] ?? n0;
    if (VIEW_NAME_SET.has(n)) want.add(n);
    else unknown.push(n0); // report the original spelling the model used
  }
  const views = ALL_VIEW_NAMES.filter((n) => want.has(n));
  return { views: views.length > 0 ? views : [...DEFAULT_VIEWS], unknown };
}

/** Compact, grouped menu of the catalog for the tool description / prompt. */
export function viewMenuText(): string {
  const labels: Record<ViewSpec["group"], string> = {
    face: "Orthographic faces",
    corner: "Isometric corners (perspective 3/4)",
    diagonal: "Eye-level diagonals",
    tilt: "Front hero tilts",
  };
  const order: Array<ViewSpec["group"]> = ["face", "corner", "diagonal", "tilt"];
  return order
    .map((g) => {
      const names = VIEW_CATALOG.filter((v) => v.group === g).map((v) => v.name);
      return `  • ${labels[g]}: ${names.join(", ")}`;
    })
    .join("\n");
}
