import { evaluate, initialize } from '../vendor/den-core-tizen3/index.js';

// Tizen 3 keeps one JavaScript policy core, but exposes both lifecycle-shaped APIs so shared Workers do not need a
// platform branch. Initializing either side initializes the same classic-script module.
export const initializeStartup = initialize;
export const evaluateStartup = evaluate;
export const initializeDeferred = initialize;
export const evaluateDeferred = evaluate;
