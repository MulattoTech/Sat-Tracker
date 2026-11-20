import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePortableSchema } from '@/src/lib/portable-recovery/schema';
import { createPortableMetadata, validatePortableMetadata, PortableMetadataError } from '@/src/lib/portable-recovery/metadata-codec';

const registry = parsePortableSchema(readFileSync('prisma/schema.prisma', 'utf8'));
const instant = '2026-11-20T01:02:03.456Z';
// Deliberately mutable malformed input for rejection tests.
const copy = (value: unknown): any => JSON.parse(JSON.stringify(value));
function row(model: string, values: Record<string, unknown>) {
  return Object.fromEntries(registry.models.find(m => m.name === model)!.fields.map(f => [f.name, Object.hasOwn(values, f.name) ? values[f.name] : f.nullable ? null : undefined]));
}
function fixture() {
  const tables = Object.fromEntries(registry.models.map(m => [m.name, [] as Record<string, unknown>[]]));
  tables.Family.push(row('Family', { id: 'family', slug: 'synthetic', name: 'Synthetic', isActive: false, setupStage: 0, createdAt: instant, updatedAt: instant, accountId: 'account' }));
  tables.Caretaker.push(row('Caretaker', { id: 'caretaker', loginId: '01', name: 'Synthetic', role: 'USER', inactive: false, securityPin: 'synthetic-secret', createdAt: instant, updatedAt: instant, familyId: 'family', accountId: 'account' }));
  tables.Account.push(row('Account', { id: 'account', email: 'synthetic@example.invalid', password: 'synthetic-hash', verified: false, betaparticipant: false, closed: false, createdAt: instant, updatedAt: instant, familyId: 'family', caretakerId: 'caretaker' }));
  tables.Baby.push(row('Baby', { id: 'baby', firstName: 'Synthetic', lastName: 'Child', birthDate: instant, inactive: false, feedWarningTime: '03:00', diaperWarningTime: '02:00', feedTimerFrom: 'start', gestationalAgeDays: 0, createdAt: instant, updatedAt: instant, familyId: 'family' }));
  tables.Unit.push(row('Unit', { id: 'unit', unitAbbr: 'ML', unitName: 'Milliliters', activityTypes: 'café\nfeed', createdAt: instant, updatedAt: instant }));
  tables.FeedLog.push(row('FeedLog', { id: 'feed', time: instant, type: 'BOTTLE', hadReaction: false, babyId: 'baby', unitAbbr: 'ML', amount: 0, createdAt: instant, updatedAt: instant }));
  tables.Feedback.push(row('Feedback', { id: 'reply', subject: 'Synthetic reply', message: 'Unicode café\nline 2', submittedAt: instant, viewed: false, createdAt: instant, updatedAt: instant, parentId: 'reply', familyId: 'family', accountId: 'account', caretakerId: 'caretaker' }));
  return createPortableMetadata(registry, { provider: 'sqlite', exportedAt: instant }, tables);
}

describe('portable metadata strict scalar and relationship preflight', () => {
  it('retains all 66 tables, exact scalars, self references and logical account links', () => {
    const metadata = fixture(), result = validatePortableMetadata(metadata, registry);
    expect(Object.keys(metadata.tables)).toHaveLength(66);
    expect(metadata.tables.Photo).toEqual({ rowCount: 0, rows: [] });
    expect(result.totalRows).toBe(7);
    expect(result.metadata.tables.Family.rows[0].accountId).toBe('account');
    expect(result.metadata.tables.Caretaker.rows[0].accountId).toBe('account');
    expect(result.metadata.tables.Account.rows[0].caretakerId).toBe('caretaker');
    expect(result.metadata.tables.Feedback.rows[0].parentId).toBe('reply');
    expect(result.metadata.tables.Baby.rows[0]).toMatchObject({ inactive: false, gestationalAgeDays: 0, gender: null, birthDate: instant });
    expect(result.metadata.tables.Unit.rows[0].activityTypes).toBe('café\nfeed');
    expect(result.insertOrder.indexOf('Baby')).toBeLessThan(result.insertOrder.indexOf('FeedLog'));
  });

  it('encodes Date objects without dropping milliseconds and freezes an independent validated copy', () => {
    const raw = copy(fixture());
    const validated = validatePortableMetadata(raw, registry);
    raw.tables.Family.rows[0].name = 'changed later';
    expect(validated.metadata.tables.Family.rows[0].name).toBe('Synthetic');
    expect(Object.isFrozen(validated.metadata.tables.Family.rows[0])).toBe(true);
    const tables = Object.fromEntries(Object.entries(fixture().tables).map(([name, table]) => [name, table.rows.map(r => ({ ...r }))]));
    tables.Family[0].updatedAt = new Date(instant) as unknown as string;
    expect(createPortableMetadata(registry, { provider: 'postgresql', exportedAt: instant }, tables).tables.Family.rows[0].updatedAt).toBe(instant);
  });

  it.each([
    ['boolean coercion', (m: any) => { m.tables.Baby.rows[0].inactive = 0; }],
    ['integer fraction', (m: any) => { m.tables.Baby.rows[0].gestationalAgeDays = 32.5; }],
    ['integer overflow', (m: any) => { m.tables.Baby.rows[0].gestationalAgeDays = 2147483648; }],
    ['nonfinite float', (m: any) => { m.tables.FeedLog.rows[0].amount = Infinity; }],
    ['unknown enum', (m: any) => { m.tables.FeedLog.rows[0].type = 'UNKNOWN'; }],
    ['missing scalar', (m: any) => { delete m.tables.Baby.rows[0].gender; }],
    ['unknown scalar', (m: any) => { m.tables.Baby.rows[0].extra = 'synthetic-secret'; }],
    ['required null', (m: any) => { m.tables.Baby.rows[0].firstName = null; }],
    ['invalid date', (m: any) => { m.tables.Baby.rows[0].birthDate = '2026-02-30T01:02:03.456Z'; }],
    ['noncanonical date', (m: any) => { m.tables.Baby.rows[0].birthDate = '2026-11-20T01:02:03.456+00:00'; }],
    ['missing table', (m: any) => { delete m.tables.Photo; }],
    ['unknown table', (m: any) => { m.tables.Unknown = { rowCount: 0, rows: [] }; }],
    ['wrong count', (m: any) => { m.tables.Baby.rowCount = 2; }],
    ['schema tampering', (m: any) => { m.schema.models[0].fields[0].nullable = !m.schema.models[0].fields[0].nullable; }],
    ['unsupported version', (m: any) => { m.version = 2; }],
  ])('rejects %s instead of coercing or discarding it', (_label, mutate) => {
    const metadata = copy(fixture()); mutate(metadata);
    expect(() => validatePortableMetadata(metadata, registry)).toThrow(PortableMetadataError);
  });

  it('rejects duplicate IDs and unique values without exposing row secrets', () => {
    const metadata = copy(fixture());
    metadata.tables.Unit.rows.push({ ...metadata.tables.Unit.rows[0], id: 'other' }); metadata.tables.Unit.rowCount++;
    try { validatePortableMetadata(metadata, registry); throw new Error('Expected a failure'); }
    catch (error) { expect(error).toBeInstanceOf(PortableMetadataError); expect(String(error)).not.toContain('synthetic-secret'); }
  });

  it('rejects unresolved declared non-ID foreign keys', () => {
    const metadata = copy(fixture()); metadata.tables.FeedLog.rows[0].unitAbbr = 'MISSING';
    expect(() => validatePortableMetadata(metadata, registry)).toThrow(PortableMetadataError);
  });

  it('allows SQL nullable unique keys to be null in more than one row', () => {
    const metadata = copy(fixture()); const first = metadata.tables.Account.rows[0];
    first.familyId = null; first.caretakerId = null;
    metadata.tables.Account.rows.push({ ...first, id: 'other-account', email: 'other@example.invalid' }); metadata.tables.Account.rowCount++;
    expect(validatePortableMetadata(metadata, registry).totalRows).toBe(8);
  });
});
