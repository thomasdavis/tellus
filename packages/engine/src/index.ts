// @tellus/engine — a terminal-native 3D engine.
//
// A CPU software rasterizer paints into an RGB framebuffer; a terminal presenter
// turns that framebuffer into truecolour Unicode cells and streams minimal ANSI
// deltas to any terminal. Scene helpers (culling, LOD, chase camera) and a
// worker-thread pool round it out. The engine knows nothing about any specific
// game — every Tellus game renders through it.
//
//   math/      vectors, 4x4 matrices, camera/projection builders
//   raster/    RasterTarget + renderMesh: the software rasterizer
//   scene/     Frustum culling, selectLod, ChaseCamera
//   terminal/  Screen cells, octant/half fitting, ANSI diffing, TerminalPresenter
//   workers/   WorkerPool for parallel off-thread rendering

export * from './math/index.js';
export * from './raster/index.js';
export * from './scene/index.js';
export * from './terminal/index.js';
export { TerminalPresenter } from './terminal/presenter.js';
export { WorkerPool, type WorkerPoolOptions } from './workers/pool.js';
