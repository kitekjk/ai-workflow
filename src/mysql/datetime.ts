export function toMysqlDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid MySQL datetime value: ${String(value)}`);
  }

  return date.toISOString().replace("T", " ").replace("Z", "");
}

export function toNullableMysqlDateTime(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : toMysqlDateTime(value);
}

export function fromMysqlDateTime(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid MySQL datetime value: ${String(value)}`);
  }

  return date.toISOString();
}
