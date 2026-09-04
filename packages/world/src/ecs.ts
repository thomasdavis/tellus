/**
 * A deliberately tiny entity-component registry.
 *
 * Entities are opaque integer ids. Components live in typed `Store`s keyed by
 * entity, so a "system" is just code that iterates the stores it cares about.
 * No archetypes, no macros — small enough to read in a minute, structured enough
 * that players, NPCs, projectiles and world props all become the same thing:
 * an id with some components hung off it.
 */
export type Entity = number;

export class Store<T> {
  private readonly data = new Map<Entity, T>();

  set(e: Entity, value: T): T {
    this.data.set(e, value);
    return value;
  }

  get(e: Entity): T | undefined {
    return this.data.get(e);
  }

  has(e: Entity): boolean {
    return this.data.has(e);
  }

  remove(e: Entity): void {
    this.data.delete(e);
  }

  get size(): number {
    return this.data.size;
  }

  values(): IterableIterator<T> {
    return this.data.values();
  }

  keys(): IterableIterator<Entity> {
    return this.data.keys();
  }

  [Symbol.iterator](): IterableIterator<[Entity, T]> {
    return this.data[Symbol.iterator]();
  }
}

export class Registry {
  private nextId: Entity = 1;
  private readonly alive = new Set<Entity>();

  create(): Entity {
    const e = this.nextId++;
    this.alive.add(e);
    return e;
  }

  destroy(e: Entity): void {
    this.alive.delete(e);
  }

  isAlive(e: Entity): boolean {
    return this.alive.has(e);
  }

  get count(): number {
    return this.alive.size;
  }
}
