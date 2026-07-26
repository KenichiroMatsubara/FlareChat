declare module '*.sql' {
  const contents: string;
  export default contents;
}

declare module 'better-sqlite3' {
  interface Statement {
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
    run(...parameters: unknown[]): { changes: number };
    raw(enabled?: boolean): Statement;
  }

  class Database {
    constructor(filename: string);
    pragma(source: string): unknown;
    prepare(source: string): Statement;
    exec(source: string): this;
    close(): void;
  }

  export default Database;
}
