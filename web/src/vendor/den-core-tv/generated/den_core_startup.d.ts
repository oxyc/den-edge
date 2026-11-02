/* tslint:disable */
/* eslint-disable */

/**
 * One list query's answer: named typed columns, `<list>.<column>`.
 */
export class ColumnsAnswer {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    names(): string[];
    /**
     * A numeric column (`NaN` for none) as a `Float64Array`.
     */
    numbers(name: string): Float64Array | undefined;
    /**
     * A text column (`""` for none).
     */
    strings(name: string): string[] | undefined;
}

/**
 * The library's documents held once in this module, and whole-library lists answered from them. Transport only: the
 * lists are den-core's (`LibraryColumns`). A refusal throws an `Error` whose message is den-core's code.
 */
export class LibraryColumns {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Continue Watching with `layouts` (JSON, by TMDB id) and `airing` (JSON, or none).
     */
    continuing(now: number, layouts: string, airing?: string | null): ColumnsAnswer;
    /**
     * `doc_decode` of one row's plaintext, its document kept here: the decode's envelope without the document.
     */
    decode(plaintext: Uint8Array, expected?: string | null): string;
    /**
     * One held document's JSON, as it was added.
     */
    document(name: string): string | undefined;
    /**
     * Every held document's JSON, as one array: what the assistant and deferred modules read documents from.
     */
    documents(): string;
    history(now: number): ColumnsAnswer;
    home(now: number): ColumnsAnswer;
    len(): number;
    constructor();
    /**
     * The newest stamp and when an answer next changes with no write.
     */
    newest(now: number): ColumnsAnswer;
    remove(name: string): boolean;
    /**
     * A JSON array of documents, each added or replaced: the number held. A document that cannot be read refuses the
     * batch.
     */
    upsert(documents: string): number;
    watchlist(now: number): ColumnsAnswer;
}

export function evaluate_startup(request: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_columnsanswer_free: (a: number, b: number) => void;
    readonly __wbg_librarycolumns_free: (a: number, b: number) => void;
    readonly columnsanswer_names: (a: number) => [number, number];
    readonly columnsanswer_numbers: (a: number, b: number, c: number) => [number, number];
    readonly columnsanswer_strings: (a: number, b: number, c: number) => [number, number];
    readonly evaluate_startup: (a: number, b: number) => [number, number];
    readonly librarycolumns_continuing: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly librarycolumns_decode: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly librarycolumns_document: (a: number, b: number, c: number) => [number, number];
    readonly librarycolumns_documents: (a: number) => [number, number];
    readonly librarycolumns_history: (a: number, b: number) => number;
    readonly librarycolumns_home: (a: number, b: number) => number;
    readonly librarycolumns_len: (a: number) => number;
    readonly librarycolumns_new: () => number;
    readonly librarycolumns_newest: (a: number, b: number) => number;
    readonly librarycolumns_remove: (a: number, b: number, c: number) => number;
    readonly librarycolumns_upsert: (a: number, b: number, c: number) => [number, number, number];
    readonly librarycolumns_watchlist: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
