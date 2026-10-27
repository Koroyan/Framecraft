/** Transitions offered in the editor (the values are FFmpeg's xfade names) and what people call them. */
export const TRANSITIONS = ['cut', 'fade', 'dissolve', 'fadeblack', 'wipeleft', 'wiperight', 'slideup', 'circleopen'] as const;
export type TransitionKey = (typeof TRANSITIONS)[number];

export const TRANSITION_LABEL: Record<TransitionKey, string> = { cut: 'Cut', fade: 'Fade', dissolve: 'Dissolve', fadeblack: 'Dip to black', wipeleft: 'Wipe left', wiperight: 'Wipe right', slideup: 'Slide up', circleopen: 'Circle reveal' };

export const transitionLabel = (type: string) => TRANSITION_LABEL[type as TransitionKey] ?? type;
