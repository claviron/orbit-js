// Ready-to-load path. Custom modules import ./binding instead.
import { createOrbit } from "./binding.js";
import { loadNative } from "./native.js";

const orbit = createOrbit(loadNative());
export const join = orbit.join;
export const serve = orbit.serve;
export { Link, Session, createOrbit } from "./binding.js";
