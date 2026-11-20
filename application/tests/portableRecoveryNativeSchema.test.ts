import { describe, expect, it } from 'vitest';
import {
  assertPhysicalMetadataSchema, loadDiagnosticLogTableName, type PhysicalMetadataColumn, type PhysicalMetadataTable,
} from '@/src/lib/portable-recovery/schema-native';
import { metadataRegistry } from './portableRecoveryTestUtils';

const types = { String: 'text', Boolean: 'boolean', DateTime: 'timestamp without time zone', Int: 'integer', Float: 'double precision', Enum: 'USER-DEFINED' };
function nativePostgreSQL(): PhysicalMetadataTable[] {
  return metadataRegistry.models.map(model => ({ name: model.name, kind: 'table', columns: model.fields.map(field => ({
    name: field.name, type: types[field.type], nullable: field.nullable, generated: false,
    ...(field.type === 'DateTime' ? { precision: 3 } : {}),
    ...(field.type === 'Enum' ? { enumName: field.enumName, enumValues: field.enumValues, enumSchemaCurrent: true } : {}),
  })) }));
}
const options = { provider: 'postgresql' as const, registry: metadataRegistry };

describe('portable native schema contracts', () => {
  it('accepts every current native column and the exact trusted diagnostic log exclusion', async () => {
    const tables = nativePostgreSQL();
    expect(() => assertPhysicalMetadataSchema(tables, options)).not.toThrow();
    expect(await loadDiagnosticLogTableName()).toBe('api_logs');
    expect(() => assertPhysicalMetadataSchema([...tables, { name: 'api_logs', kind: 'table', columns: [] }], options)).not.toThrow();
  });

  it.each([
    ['extra label', (column: PhysicalMetadataColumn) => { column.enumValues = [...column.enumValues!, 'UNRECOGNIZED']; }],
    ['missing label', (column: PhysicalMetadataColumn) => { column.enumValues = column.enumValues!.slice(1); }],
    ['different order', (column: PhysicalMetadataColumn) => { column.enumValues = [...column.enumValues!].reverse(); }],
    ['another namespace', (column: PhysicalMetadataColumn) => { column.enumSchemaCurrent = false; }],
    ['missing catalog evidence', (column: PhysicalMetadataColumn) => { delete column.enumValues; }],
  ])('rejects enum drift with %s before any row import', (_label, change) => {
    const tables = nativePostgreSQL();
    const table = tables.find(table => table.columns.some(column => (column.enumValues?.length ?? 0) > 1))!;
    const column = table.columns.find(column => (column.enumValues?.length ?? 0) > 1)!;
    change(column);
    expect(() => assertPhysicalMetadataSchema(tables, options)).toThrowError('PHYSICAL_SCHEMA_MISMATCH');
  });

  it('rejects timestamp precision drift and identity generation rather than changing imported values', () => {
    for (const kind of ['precision', 'identity'] as const) {
      const tables = nativePostgreSQL();
      const date = tables.flatMap(table => [...table.columns]).find(column => column.precision === 3)!;
      if (kind === 'precision') date.precision = 6;
      else date.generated = true;
      expect(() => assertPhysicalMetadataSchema(tables, options)).toThrowError('PHYSICAL_SCHEMA_MISMATCH');
    }
  });
});
