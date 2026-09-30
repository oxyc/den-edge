import { describe, expect, it } from 'vitest';
import { blankTitle } from './actions';
import {
  writeImportBatches,
  type ImportRowWriter,
  type ImportWrites,
} from './viewingImportJournal';

const writes = (count: number): ImportWrites[] => [
  {
    key: 'movies',
    rows: Array.from({ length: count }, (_, at) => blankTitle({ type: 'movie', id: at + 1 }, at)),
  },
];

describe('viewing import batches', () => {
  it('writes bounded batches and reports progress through the final short batch', async () => {
    const sizes: number[] = [];
    const progress: number[] = [];
    const writer: ImportRowWriter = {
      refusal: null,
      writeRows: async (rows) => (sizes.push(rows.length), true),
    };
    expect(await writeImportBatches(writes(5), writer, (done) => progress.push(done), 2)).toEqual({
      complete: true,
      written: 5,
      total: 5,
    });
    expect(sizes).toEqual([2, 2, 1]);
    expect(progress).toEqual([2, 4, 5]);
  });

  it('stops at a refused batch and says exactly how many rows a repeat can recover', async () => {
    let call = 0;
    const writer: ImportRowWriter = {
      refusal: null,
      writeRows: async () => {
        call++;
        if (call === 2) {
          writer.refusal = 'library_full';
          return false;
        }
        return true;
      },
    };
    expect(await writeImportBatches(writes(5), writer, undefined, 2)).toEqual({
      complete: false,
      written: 2,
      total: 5,
      refusal: 'library_full',
    });
    expect(call).toBe(2);
  });
});
