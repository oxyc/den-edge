import {
  applyLog,
  ContinueProjector,
  emptyLibrary,
  nameContinueCandidates,
  withDisplay,
  type Library,
  type Shape,
  type Title,
} from '../src/lib/library';
import type { Row } from '../src/lib/wire';

interface FixtureSession {
  revision: number;
  log?: { rows: () => Row[] } | null;
  displays: Title[];
  shapes: Map<string, Shape>;
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
};
