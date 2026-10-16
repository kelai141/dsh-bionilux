/**
 * Minimal stand-in for the `react` specifier.
 *
 * The real client half is rendered by the DSH Mobile UI host, which supplies
 * React from its own bundle (it is a peer dependency here, not a bundled one).
 * Tests only exercise module loading and slot registration, so the surface
 * needed is `createElement` plus the two hooks the section imports.
 */
export const createElement = (type, props, ...children) => ({ type, props: props ?? null, children })
export const useEffect = () => {}
export const useState = (initial) => [initial, () => {}]

export default { createElement, useEffect, useState }
