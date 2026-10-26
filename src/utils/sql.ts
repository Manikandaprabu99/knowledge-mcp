/**
 * Collects positional parameters while a query is assembled, so every value is
 * sent as a bind parameter ($1, $2, ...) and never interpolated into SQL text.
 */
export class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}
