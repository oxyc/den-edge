import { pressedTitleState, type Press, type SaveKind } from './pressedTitleState';
import type { Reaction, TitleState } from './titleState';
import type { TitleRow } from './wire';

/**
 * The press on one title's actions that is being saved, if any. It is shown the moment it is made, and stays shown
 * until its own save ends, whatever the row does meanwhile.
 */
export class PressedTitle {
  #press = $state.raw<Press | null>(null);

  /** Nothing of this title's is being saved. */
  get idle(): boolean {
    return this.#press === null;
  }

  begin(kind: SaveKind, value: Press['value'], button?: Reaction): void {
    this.#press = { kind, value, ...(button ? { button } : {}) };
  }

  /** The press is saved or has failed: the row says which, so it stops being laid over it. */
  end(): void {
    this.#press = null;
  }

  /** Whether the save under way is for this control: an opinion's button is the one it was pressed on. */
  saving(kind: SaveKind, button?: Reaction): boolean {
    const press = this.#press;
    return press?.kind === kind && (button === undefined || press.button === button);
  }

  state(row: TitleRow | undefined): TitleState {
    return pressedTitleState(row, this.#press);
  }
}
