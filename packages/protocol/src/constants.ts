/**
 * Shared, authoritative constants. Client and server MUST agree on these — the
 * whole prediction/reconciliation model depends on both sides simulating with
 * identical numbers.
 */
export const PROTOCOL_VERSION = 1;

/** Server authoritative simulation rate (Hz) and the derived fixed timestep. */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;

/** How often the client streams its input to the server (Hz). */
export const INPUT_RATE = 30;

/** The world is a square centred on the origin, spanning [-WORLD_HALF, WORLD_HALF]. */
export const WORLD_HALF = 120;

/** Movement speeds in metres/second. */
export const WALK_SPEED = 4.5;
export const RUN_SPEED = 9.5;

/** Player capsule radius, used for world-bounds clamping and (later) collision. */
export const PLAYER_RADIUS = 0.4;

/**
 * Area-of-interest radius (metres). A client is only told about entities within
 * this range — the core MMO trick that keeps bandwidth flat as the world grows.
 */
export const AOI_RADIUS = 80;

/** Spatial-hash cell size. Should be >= AOI_RADIUS / 2 for cheap neighbour queries. */
export const CELL_SIZE = 40;

/** Animation states, shared so the wire can carry a single byte. */
export const Anim = { Idle: 0, Walk: 1, Run: 2 } as const;
export type Anim = (typeof Anim)[keyof typeof Anim];
