import {
  applyLog,
  ContinueProjector,
  emptyLibrary,
  nameContinueCandidates,
  standings,
  withDisplay,
  type Library,
  type Shape,
  type Title,
} from '../src/lib/library';
import type { Row } from '../src/lib/wire';

interface FixtureSession {
  revision: number;
  log?: {
    rows: () => Row[];
    kept?: <T>(name: string) => Promise<T | undefined>;
    keep?: <T>(name: string, value: T) => Promise<void>;
  } | null;
  displays: Title[];
  shapes: Map<string, Shape>;
  publishLibraryMetadata(titles: Title[], shapes: ReadonlyArray<readonly [string, Shape]>): void;
}

const projections = new WeakMap<
  object,
  { revision: number; log: NonNullable<FixtureSession['log']>; rows: Row[]; library: Library }
>();
const projectors = new WeakMap<object, ContinueProjector>();

/** The production projection API for lightweight Library fixtures that deliberately do not construct a session. */
export const fixtureLibrarySessionMethods = {
  /** Provider delivery is outside these lightweight layout/navigation fixtures. */
  foregroundReady(): void {},

  kept<T>(this: FixtureSession, name: string): Promise<T | undefined> {
    return this.log?.kept?.<T>(name) ?? Promise.resolve(undefined);
  },

  async keep<T>(this: FixtureSession, name: string, value: T): Promise<void> {
    await this.log?.keep?.(name, value);
  },

  publishLibraryMetadata(
    this: FixtureSession,
    titles: Title[],
    shapes: ReadonlyArray<readonly [string, Shape]>,
  ): void {
    const known = new Set(this.displays.map((title) => `${title.type}:${title.id}`));
    const added = titles.filter((title) => !known.has(`${title.type}:${title.id}`));
    if (added.length) this.displays = [...this.displays, ...added];
    if (shapes.length) this.shapes = new Map([...this.shapes, ...shapes]);
  },

  rememberTitle(this: FixtureSession, title: Title): void {
    this.publishLibraryMetadata([title], []);
  },

  displayTitle(this: FixtureSession, ref: Pick<Title, 'type' | 'id'>): Title | undefined {
    return this.displays.find((title) => title.type === ref.type && title.id === ref.id);
  },

  displayTitles(this: FixtureSession): ReadonlyMap<string, Title> {
    return new Map(this.displays.map((title) => [`${title.type}:${title.id}`, title]));
  },

  libraryProjection(this: FixtureSession): { rows: Row[]; library: Library } | null {
    const log = this.log;
    if (!log) return null;
    let held = projections.get(this);
    if (!held || held.revision !== this.revision || held.log !== log) {
      const rows = log.rows();
      held = { revision: this.revision, log, rows, library: applyLog(emptyLibrary(), rows) };
      projections.set(this, held);
    }
    return held;
  },

  displayedLibrary(this: FixtureSession, projection: Library): Library {
    return { ...withDisplay(projection, this.displays), shapes: this.shapes };
  },

  continueWatching(this: FixtureSession, projection: Library, displayed: Library) {
    let projector = projectors.get(this);
    if (!projector) {
      projector = new ContinueProjector();
      projectors.set(this, projector);
    }
    return nameContinueCandidates(
      projector.project({ ...projection, shapes: this.shapes }),
      displayed,
    );
  },

  async projectDetailLibrarySnapshot(
    this: FixtureSession,
    _tmdbKey: string,
    shouldContinue: () => boolean = () => true,
  ) {
    const revision = this.revision;
    await Promise.resolve();
    if (!shouldContinue() || this.revision !== revision) return null;
    const projection = fixtureLibrarySessionMethods.libraryProjection.call(this);
    if (!projection) return null;
    const displayed = fixtureLibrarySessionMethods.displayedLibrary.call(this, projection.library);
    return {
      revision,
      continue: fixtureLibrarySessionMethods.continueWatching.call(
        this,
        projection.library,
        displayed,
      ),
      standings: standings(projection.library),
      exactContinue: true,
    };
  },
};
