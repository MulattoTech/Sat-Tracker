import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { canonicalStringify, parsePortableSchema, PortableSchemaError } from '@/src/lib/portable-recovery/schema';

const source = readFileSync('prisma/schema.prisma', 'utf8');

describe('portable recovery trusted schema inventory', () => {
  it('covers every canonical model and scalar, including empty and formerly omitted tables', () => {
    const registry = parsePortableSchema(source);
    expect(registry.models).toHaveLength(66);
    expect(registry.models.flatMap(m => m.fields)).toHaveLength(766);
    expect(registry.models.flatMap(m => m.fields).filter(f => f.nullable)).toHaveLength(286);
    expect(registry.models.flatMap(m => m.foreignKeys)).toHaveLength(116);
    expect(registry.models.filter(m => m.primaryKey.length > 1)).toHaveLength(6);
    expect(new Set(registry.models.flatMap(m => m.fields).filter(f => f.enumName).map(f => f.enumName)).size).toBe(19);
    for (const model of Prisma.dmmf.datamodel.models) {
      expect(registry.models.find(m => m.name === model.name)?.fields.map(f => f.name).sort()).toEqual(
        model.fields.filter(f => f.kind !== 'object').map(f => f.name).sort(),
      );
    }
    expect(registry.models.find(m => m.name === 'FeedLog')?.foreignKeys).toContainEqual({ fields: ['unitAbbr'], referencedModel: 'Unit', referencedFields: ['unitAbbr'] });
    expect(registry.models.find(m => m.name === 'Feedback')?.foreignKeys).toContainEqual({ fields: ['parentId'], referencedModel: 'Feedback', referencedFields: ['id'] });
    expect(registry.models.find(m => m.name === 'Caretaker')?.foreignKeys.some(f => f.fields.includes('accountId'))).toBe(false);
    expect(registry.models.find(m => m.name === 'Account')?.foreignKeys.some(f => f.fields.includes('caretakerId'))).toBe(true);
  });

  it('keeps the logical fingerprint independent of provider, comments and irrelevant formatting', () => {
    const a = parsePortableSchema(source);
    const b = parsePortableSchema(source.replace('provider = "sqlite"', 'provider = "postgresql"').replace(/String[ \t]+/g, 'String    ') + '\n// synthetic comment\n');
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(parsePortableSchema(source.replace('gestationalAgeDays Int?', 'gestationalAgeDays Int')).fingerprint).not.toBe(a.fingerprint);
    expect(parsePortableSchema(source.replace('  NIGHT_SLEEP', '  SYNTHETIC_SLEEP')).fingerprint).not.toBe(a.fingerprint);
    expect(a.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each(['BigInt', 'Bytes', 'Json', 'Decimal', 'Unsupported("blob")', 'String[]'])(
    'fails closed for an unsupported scalar declaration %s', type => {
      expect(() => parsePortableSchema(source.replace('  adminPass   String', `  adminPass   ${type}`))).toThrow(PortableSchemaError);
    },
  );

  it('refuses identities, mappings and unrecognized model constraints instead of omitting them', () => {
    expect(() => parsePortableSchema(source.replace('@default(cuid())', '@default(autoincrement())'))).toThrow(PortableSchemaError);
    expect(() => parsePortableSchema(source.replace('  adminPass   String', '  adminPass   String @map("password")'))).toThrow(PortableSchemaError);
    expect(() => parsePortableSchema(source.replace('@@index([email])', '@@unknown([email])'))).toThrow(PortableSchemaError);
  });

  it('rejects a reference that no longer points at a unique key', () => {
    expect(() => parsePortableSchema(source.replace('unitAbbr      String   @unique', 'unitAbbr      String'))).toThrow(PortableSchemaError);
  });

  it('canonicalizes object key order without coercing non-JSON values', () => {
    expect(canonicalStringify({ b: [false, 0, null], a: 'café' })).toBe('{"a":"café","b":[false,0,null]}');
    expect(() => canonicalStringify({ secret: undefined })).toThrow(PortableSchemaError);
  });
});
