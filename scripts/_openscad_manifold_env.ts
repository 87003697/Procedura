/**
 * Pin OPENSCAD_PATH to the Manifold-capable OpenSCAD before anything imports
 * `src/scad/compile.ts`. Import this FIRST in any script that compiles a lot of
 * SCAD.
 *
 * The candidate list and the Manifold probe live in `src/scad/compile.ts` — it
 * already has to resolve the binary for its own use, and two lists that drift
 * apart is exactly how a script ends up on the 2021.01 CGAL build while the
 * pipeline is on 2026.04.04. Importing it here also exports the env var to any
 * SUBPROCESS the script spawns, which is the part compile.ts cannot do itself.
 */
import { OPENSCAD_PATH } from "../src/scad/compile.ts";

process.env["OPENSCAD_PATH"] = OPENSCAD_PATH;

export const OPENSCAD_BIN = OPENSCAD_PATH;
