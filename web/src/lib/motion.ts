/**
 * One motion system for the whole app.
 *
 * Two springs and one ease, used everywhere so movement feels like one
 * material: `spring` for things that move between places (a selection
 * highlight, a segmented thumb, a reordered list), `sheet` for surfaces that
 * arrive (dialogs, panels), and `ease` for content that fades in place. Every
 * preset collapses to zero under prefers-reduced-motion via `useMotion()`.
 */

import type { Transition, Variants } from "motion/react";
import { useReducedMotion } from "motion/react";

export const spring: Transition = { type: "spring", stiffness: 560, damping: 44, mass: 0.8 };
export const sheet: Transition = { type: "spring", stiffness: 420, damping: 36, mass: 0.9 };
export const ease: Transition = { duration: 0.2, ease: [0.22, 0.8, 0.24, 1] };
export const none: Transition = { duration: 0 };

/** Content arriving in place: a short rise. */
export const rise: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: ease },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12 } },
};

/** Crossfade without displacement — for swapping views inside a fixed frame. */
export const fade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: ease },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};

/** A small element appearing: pop with a spring. */
export const pop: Variants = {
  initial: { opacity: 0, scale: 0.85 },
  animate: { opacity: 1, scale: 1, transition: spring },
  exit: { opacity: 0, scale: 0.9, transition: { duration: 0.1 } },
};

/** A sheet presenting from slightly below, slightly scaled. */
export const present: Variants = {
  initial: { opacity: 0, scale: 0.97, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0, transition: sheet },
  exit: { opacity: 0, scale: 0.98, y: 6, transition: { duration: 0.14 } },
};

/** A panel sliding in from the trailing edge. */
export const slideIn: Variants = {
  initial: { opacity: 0, x: 28 },
  animate: { opacity: 1, x: 0, transition: sheet },
  exit: { opacity: 0, x: 20, transition: { duration: 0.14 } },
};

/** Parent variants that stagger children using `rise` / `pop`. */
export const staggered = (gap = 0.025): Variants => ({
  animate: { transition: { staggerChildren: gap, delayChildren: 0.02 } },
});

/** Reduced-motion aware helpers. Components ask once and pass the answers to
 *  motion props, so a user who turned animation off gets none of it. */
export function useMotion() {
  const reduce = !!useReducedMotion();
  return {
    reduce,
    /** Variants, or nothing when motion is off. */
    v: <T extends Variants>(variants: T): T | undefined => (reduce ? undefined : variants),
    /** A transition, or an instant one when motion is off. */
    t: (transition: Transition): Transition => (reduce ? none : transition),
  };
}
