/** Selected reports are spreadsheet-facing, unlike canonical backup data.
 * Keep a leading formula marker literal even after whitespace/control chars. */
export function literalCsvCell(value: string): string {
  return /^[\s\u0000-\u001f]*[=+@-]/u.test(value) ? `'${value}` : value;
}
