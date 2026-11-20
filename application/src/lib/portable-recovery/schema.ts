import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type PortableFieldType = 'String' | 'Boolean' | 'DateTime' | 'Int' | 'Float' | 'Enum';
export interface PortableField {
  name: string;
  type: PortableFieldType;
  nullable: boolean;
  enumName?: string;
  enumValues?: readonly string[];
  default?: { kind: 'function'; name: 'uuid' | 'cuid' | 'now' } | { kind: 'literal'; value: string | number | boolean };
  updatedAt?: true;
}
export interface PortableForeignKey {
  fields: readonly string[];
  referencedModel: string;
  referencedFields: readonly string[];
  onDelete?: string;
  onUpdate?: string;
}
export interface PortableModel {
  name: string;
  fields: readonly PortableField[];
  primaryKey: readonly string[];
  uniqueConstraints: readonly (readonly string[])[];
  indexes: readonly (readonly string[])[];
  foreignKeys: readonly PortableForeignKey[];
}
export interface PortableSchemaRegistry {
  fingerprint: string;
  models: readonly PortableModel[];
}

export class PortableSchemaError extends Error {
  readonly code = 'UNSUPPORTED_SCHEMA';
  constructor(location: string) {
    super(`Unsupported portable metadata schema at ${location}`);
    this.name = 'PortableSchemaError';
  }
}

/** Stable JSON for fingerprints and persisted-value comparison, never a display formatter. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new PortableSchemaError('non-JSON value');
}

const identifier = /^[A-Za-z_]\w*$/;
const scalarTypes = new Set(['String', 'Boolean', 'DateTime', 'Int', 'Float']);
function fail(location: string): never { throw new PortableSchemaError(location); }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function splitArguments(value: string, location: string): string[] {
  const parts: string[] = [];
  let start = 0, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '(') depth++;
    else if (char === ']' || char === ')') { if (--depth < 0) fail(location); }
    else if (char === ',' && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  if (quoted || depth !== 0) fail(location);
  parts.push(value.slice(start).trim());
  return parts;
}

function fieldList(value: string, location: string): string[] {
  if (!/^\[[\s\S]*\]$/.test(value)) return fail(location);
  const fields = value.slice(1, -1).split(',').map(s => s.trim());
  if (!fields.length || fields.some(s => !identifier.test(s)) || new Set(fields).size !== fields.length) return fail(location);
  return fields;
}

function attributes(value: string, location: string): Map<string, string | null> {
  const result = new Map<string, string | null>();
  let rest = value.trim();
  while (rest) {
    const match = /^@(\w+)/.exec(rest);
    if (!match || result.has(match[1])) return fail(location);
    const name = match[1];
    rest = rest.slice(match[0].length);
    let args: string | null = null;
    if (rest.startsWith('(')) {
      let depth = 1, quoted = false, escaped = false, end = 1;
      for (; end < rest.length && depth; end++) {
        const char = rest[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '(') depth++;
        else if (char === ')') depth--;
      }
      if (depth || quoted) return fail(location);
      args = rest.slice(1, end - 1).trim();
      rest = rest.slice(end);
    }
    if (rest && !/^\s/.test(rest)) return fail(location);
    result.set(name, args);
    rest = rest.trim();
  }
  return result;
}

function parseDefault(value: string | null, field: PortableField, location: string): NonNullable<PortableField['default']> {
  if (value === null) return fail(location);
  if (value === 'uuid()' || value === 'cuid()' || value === 'now()') {
    const name = value.slice(0, -2) as 'uuid' | 'cuid' | 'now';
    if ((name === 'now' && field.type !== 'DateTime') || (name !== 'now' && field.type !== 'String')) return fail(location);
    return { kind: 'function', name };
  }
  if (field.type === 'Enum' && field.enumValues?.includes(value)) return { kind: 'literal', value };
  let literal: unknown;
  try { literal = JSON.parse(value); } catch { return fail(location); }
  const valid = (field.type === 'String' && typeof literal === 'string') ||
    (field.type === 'Boolean' && typeof literal === 'boolean') ||
    (field.type === 'Float' && typeof literal === 'number' && Number.isFinite(literal)) ||
    (field.type === 'Int' && typeof literal === 'number' && Number.isInteger(literal) && literal >= -2147483648 && literal <= 2147483647);
  if (!valid) return fail(location);
  return { kind: 'literal', value: literal as string | number | boolean };
}

/** Parses only the trusted, supported Prisma storage schema; new syntax must be reviewed explicitly. */
export function parsePortableSchema(source: string): PortableSchemaRegistry {
  const clean = source.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    token => token.startsWith('"') ? token : token.replace(/[^\n]/g, ' '));
  const blocks = [...clean.matchAll(/^\s*(model|enum|generator|datasource)\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)];
  if (!blocks.length || clean.replace(/^\s*(model|enum|generator|datasource)\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm, '').trim()) fail('top level');
  const modelBlocks = blocks.filter(b => b[1] === 'model');
  const modelNames = new Set(modelBlocks.map(b => b[2]));
  if (!modelNames.size || modelNames.size !== modelBlocks.length) fail('model names');
  const enums = new Map<string, string[]>();
  for (const block of blocks.filter(b => b[1] === 'enum')) {
    const values = block[3].split(/\s+/).filter(Boolean);
    if (enums.has(block[2]) || modelNames.has(block[2]) || !values.length || values.some(v => !identifier.test(v)) || new Set(values).size !== values.length) fail(block[2]);
    enums.set(block[2], values);
  }
  const models: PortableModel[] = [];
  for (const block of modelBlocks) {
    const name = block[2], fields: PortableField[] = [], uniqueConstraints: string[][] = [], indexes: string[][] = [], foreignKeys: PortableForeignKey[] = [];
    const names = new Set<string>();
    let primaryKey: string[] | undefined;
    for (const raw of block[3].split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('@@')) {
        const attr = attributes(line.slice(1), name);
        if (attr.size !== 1) fail(name);
        const [kind, args] = [...attr][0];
        if (!['id', 'unique', 'index'].includes(kind) || args === null) fail(name);
        const keys = fieldList(args!, name);
        if (kind === 'id') { if (primaryKey) fail(name); primaryKey = keys; }
        else if (kind === 'unique') uniqueConstraints.push(keys);
        else indexes.push(keys);
        continue;
      }
      const match = /^(\w+)\s+(\w+)(\?|\[\])?(?:\s+(.*))?$/.exec(line);
      if (!match || names.has(match[1])) fail(name);
      const [, fieldName, type, modifier, tail = ''] = match!;
      names.add(fieldName);
      const location = `${name}.${fieldName}`, attrs = attributes(tail, location);
      if (modelNames.has(type)) {
        if ([...attrs.keys()].some(k => k !== 'relation')) fail(location);
        if (attrs.has('relation')) {
          const args = attrs.get('relation');
          if (args === null) fail(location);
          const properties = new Map<string, string>();
          for (const [i, arg] of splitArguments(args!, location).entries()) {
            if (i === 0 && /^"(?:\\.|[^"\\])*"$/.test(arg)) continue;
            const property = /^(fields|references|onDelete|onUpdate):\s*(.+)$/.exec(arg);
            if (!property || properties.has(property[1])) fail(location);
            properties.set(property![1], property![2]);
          }
          if (properties.has('fields') !== properties.has('references')) fail(location);
          if (properties.has('fields')) {
            if (modifier === '[]') fail(location);
            const fk: PortableForeignKey = { fields: fieldList(properties.get('fields')!, location), referencedModel: type, referencedFields: fieldList(properties.get('references')!, location) };
            for (const action of ['onDelete', 'onUpdate'] as const) {
              const value = properties.get(action);
              if (value !== undefined) {
                if (!['Cascade', 'Restrict', 'NoAction', 'SetNull', 'SetDefault'].includes(value)) fail(location);
                fk[action] = value;
              }
            }
            foreignKeys.push(fk);
          } else if (properties.size) fail(location);
        }
        continue;
      }
      if ((!scalarTypes.has(type) && !enums.has(type)) || modifier === '[]' || [...attrs.keys()].some(k => !['id', 'unique', 'default', 'updatedAt'].includes(k))) fail(location);
      const field: PortableField = { name: fieldName, type: enums.has(type) ? 'Enum' : type as PortableFieldType, nullable: modifier === '?' };
      if (enums.has(type)) { field.enumName = type; field.enumValues = enums.get(type)!; }
      for (const marker of ['id', 'unique', 'updatedAt']) if (attrs.has(marker) && attrs.get(marker) !== null) fail(location);
      if (attrs.has('id')) { if (primaryKey || field.nullable) fail(location); primaryKey = [fieldName]; }
      if (attrs.has('unique')) uniqueConstraints.push([fieldName]);
      if (attrs.has('updatedAt')) { if (field.type !== 'DateTime') fail(location); field.updatedAt = true; }
      if (attrs.has('default')) field.default = parseDefault(attrs.get('default')!, field, location);
      fields.push(field);
    }
    if (!primaryKey?.length) fail(name);
    const fieldNames = new Set(fields.map(f => f.name));
    for (const keys of [primaryKey!, ...uniqueConstraints, ...indexes, ...foreignKeys.map(f => f.fields)]) {
      if (keys.some(k => !fieldNames.has(k))) fail(name);
    }
    if (primaryKey!.some(k => fields.find(f => f.name === k)!.nullable)) fail(name);
    const sortLists = (a: readonly string[], b: readonly string[]) => compare(canonicalStringify(a), canonicalStringify(b));
    models.push({ name, fields: fields.sort((a, b) => compare(a.name, b.name)), primaryKey: primaryKey!, uniqueConstraints: uniqueConstraints.sort(sortLists), indexes: indexes.sort(sortLists), foreignKeys: foreignKeys.sort((a, b) => compare(canonicalStringify(a), canonicalStringify(b))) });
  }
  for (const model of models) for (const fk of model.foreignKeys) {
    const target = models.find(m => m.name === fk.referencedModel)!;
    if (fk.fields.length !== fk.referencedFields.length || ![target.primaryKey, ...target.uniqueConstraints].some(keys => canonicalStringify(keys) === canonicalStringify(fk.referencedFields))) fail(model.name);
    for (let i = 0; i < fk.fields.length; i++) {
      const local = model.fields.find(f => f.name === fk.fields[i])!, remote = target.fields.find(f => f.name === fk.referencedFields[i]);
      if (!remote || local.type !== remote.type || local.enumName !== remote.enumName) fail(model.name);
    }
  }
  models.sort((a, b) => compare(a.name, b.name));
  return { models, fingerprint: `sha256:${createHash('sha256').update(canonicalStringify(models)).digest('hex')}` };
}

/** The path is operator-controlled, never an archive/request field. No environment or database is read. */
export async function loadPortableSchema(schemaPath = resolve(process.cwd(), 'prisma/schema.prisma')): Promise<PortableSchemaRegistry> {
  return parsePortableSchema(await readFile(schemaPath, 'utf8'));
}
