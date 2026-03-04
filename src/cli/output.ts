export type OutputFormat = "table" | "json" | "minimal";

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function formatTable(
  rows: Record<string, unknown>[],
  columns?: string[],
): string {
  if (rows.length === 0) return "(no results)";

  const cols = columns ?? Object.keys(rows[0]);

  // Compute column widths
  const widths: Record<string, number> = {};
  for (const col of cols) {
    widths[col] = col.length;
    for (const row of rows) {
      const val = String(row[col] ?? "");
      widths[col] = Math.max(widths[col], val.length);
    }
  }

  // Header
  const header = cols.map((c) => c.padEnd(widths[c])).join("  ");
  const separator = cols.map((c) => "-".repeat(widths[c])).join("  ");

  // Rows
  const body = rows.map((row) =>
    cols.map((c) => String(row[c] ?? "").padEnd(widths[c])).join("  "),
  );

  return [header, separator, ...body].join("\n");
}

export function formatMinimal(data: unknown): string {
  if (Array.isArray(data)) {
    return data
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          return Object.values(item).join("\t");
        }
        return String(item);
      })
      .join("\n");
  }
  if (typeof data === "object" && data !== null) {
    return Object.entries(data as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }
  return String(data);
}

export function formatOutput(
  data: unknown,
  format: OutputFormat,
  columns?: string[],
): string {
  switch (format) {
    case "json":
      return formatJson(data);
    case "minimal":
      return formatMinimal(data);
    case "table":
      if (Array.isArray(data)) {
        return formatTable(data, columns);
      }
      if (typeof data === "object" && data !== null) {
        return formatTable([data as Record<string, unknown>], columns);
      }
      return String(data);
  }
}
