import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { copyText } from './clipboard';

let warned: unknown[][] = [];

beforeEach(() => {
  warned = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warned.push(args));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('writes straight to the clipboard when the browser allows it', async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const select = vi.fn();

  expect(await copyText('hello', select)).toBe('copied');
  expect(writeText).toHaveBeenCalledWith('hello');
  expect(select).not.toHaveBeenCalled();
  expect(warned).toEqual([]);
});

test('prefers navigator.clipboard.write with a ClipboardItem, so a value still arriving can be handed in now', async () => {
  const write = vi.fn(async () => undefined);
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { clipboard: { write, writeText } });
  class FakeClipboardItem {
    data: Record<string, unknown>;
    constructor(data: Record<string, unknown>) {
      this.data = data;
    }
  }
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  vi.stubGlobal('Blob', class {} as unknown as typeof Blob);

  expect(await copyText('hello')).toBe('copied');
  expect(write).toHaveBeenCalledTimes(1);
  expect(writeText).not.toHaveBeenCalled();
});

test('a value that is still on its way goes onto the clipboard as a promised ClipboardItem', async () => {
  const write = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { clipboard: { write } });
  class FakeClipboardItem {
    data: Record<string, unknown>;
    constructor(data: Record<string, unknown>) {
      this.data = data;
    }
  }
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  vi.stubGlobal('Blob', class {} as unknown as typeof Blob);

  let resolveCode: (code: string) => void = () => {};
  const code = new Promise<string>((resolve) => (resolveCode = resolve));
  const result = copyText(code);
  resolveCode('a-code-that-just-arrived');
  expect(await result).toBe('copied');
  expect(write).toHaveBeenCalledTimes(1);
});

test('falls back to selecting the field and execCommand when the Clipboard API is refused', async () => {
  const writeText = vi.fn(async () => Promise.reject(new DOMException('nope', 'NotAllowedError')));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const execCommand = vi.fn(() => true);
  vi.stubGlobal('document', { execCommand });
  const select = vi.fn();

  expect(await copyText('hello', select)).toBe('copied');
  expect(select).toHaveBeenCalledOnce();
  expect(execCommand).toHaveBeenCalledWith('copy');
  expect(warned.length).toBe(1);
  expect(warned[0]?.[0]).toMatch(/clipboard write was refused/);
});

test('leaves the field selected for a long-press copy when every programmatic path fails', async () => {
  const writeText = vi.fn(async () => Promise.reject(new DOMException('nope', 'NotAllowedError')));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const execCommand = vi.fn(() => false);
  vi.stubGlobal('document', { execCommand });
  const select = vi.fn();

  expect(await copyText('hello', select)).toBe('manual');
  expect(select).toHaveBeenCalledOnce();
  expect(execCommand).toHaveBeenCalledWith('copy');
  expect(warned.length).toBe(2);
});

test('with nothing to select, a refused write just reports manual', async () => {
  const writeText = vi.fn(async () => Promise.reject(new DOMException('nope', 'NotAllowedError')));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const execCommand = vi.fn(() => false);
  vi.stubGlobal('document', { execCommand });

  expect(await copyText('hello')).toBe('manual');
  expect(execCommand).toHaveBeenCalledWith('copy');
});

test('an execCommand that throws (no selection to copy) is caught and reported as manual', async () => {
  const writeText = vi.fn(async () => Promise.reject(new DOMException('nope', 'NotAllowedError')));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const execCommand = vi.fn(() => {
    throw new Error('nothing selected');
  });
  vi.stubGlobal('document', { execCommand });
  const select = vi.fn();

  expect(await copyText('hello', select)).toBe('manual');
  expect(select).toHaveBeenCalledOnce();
  expect(warned.length).toBe(2);
  expect(warned[1]?.[0]).toMatch(/clipboard fallback copy failed/);
});
