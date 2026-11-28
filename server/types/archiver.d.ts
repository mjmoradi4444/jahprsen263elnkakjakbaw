// Minimal typings for archiver v8 (the package ships no type definitions).
declare module 'archiver' {
  import { Readable, Transform } from 'node:stream';

  export interface EntryData {
    name: string;
    date?: Date;
  }

  export class ZipArchive extends Transform {
    constructor(options?: { zlib?: { level?: number }; forceZip64?: boolean });
    append(source: Readable | Buffer | string, data: EntryData): this;
    file(filepath: string, data: EntryData): this;
    finalize(): Promise<void>;
    abort(): this;
    pointer(): number;
    on(event: 'entry', listener: (entry: EntryData) => void): this;
    on(event: 'warning' | 'error', listener: (err: Error & { code?: string }) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}
