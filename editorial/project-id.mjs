// The internal project identifier written into the queue, evidence snapshots, artifacts, worker envelopes
// and the update journal. It keeps its historical value so stored state stays valid; it is not the product name.
export const PROJECT_ID='vmeste';
// Stored format ids: the type tag of a correction report an owner imports, and of a plan the interface exports.
export const CORRECTION_FORMAT='vmeste-correction';
export const PLAN_FORMAT='vmeste-plan';
