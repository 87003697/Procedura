/**
 * Surface the Cycles device a Blender render actually used.
 *
 * `scripts/_blender_gpu.py` prints the backend and device it selected precisely
 * so that a silent CPU fallback stops being invisible — but every renderer here
 * captures Blender's stdout and, on success, throws it away. The one line that
 * exists to be seen was the one nobody could see.
 *
 * A CPU fallback is a ~7x regression with no other symptom, so it belongs in the
 * run log next to the render it describes.
 */

/** The `[render] device: …` line from a Blender run, if it printed one. */
export function deviceLine(stdout: string): string | null {
  const m = /^\[render\] device:.*$/m.exec(stdout);
  return m ? m[0].trim() : null;
}
