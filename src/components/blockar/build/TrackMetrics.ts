/** Centralized metric coaster constants (1 world unit = 1 m). Path scale is independent of these. */
export const TRACK_METRICS = {
  GAUGE: 0.12,
  RAIL_RADIUS: 0.012,
  SPINE_RADIUS: 0.016,
  TIE_SPACING: 0.15,
  SUPPORT_SPACING: 0.3,
  /** Tunable stroke sampling target (m). */
  SAMPLE_SPACING: 0.05,
  /** Max single-step before a sample counts as a tracking jump (m). */
  MAX_STEP: 0.25,
  /** Max plausible hand drawing speed (m/s). */
  MAX_SPEED: 3.0,
  /** A new stroke must start within this of the track end (m). */
  MAX_JOIN: 0.3,
  /** Direction change below this (deg) extends the current straight run instead of adding a bend. */
  STRAIGHT_ANGLE_DEG: 6,
  /** Perpendicular deviation tolerated inside a straight run (m). */
  STRAIGHT_TOLERANCE: 0.012,
} as const;
