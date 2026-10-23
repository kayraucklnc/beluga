/**
 * Checking a task's structured result against what was asked for: the useful part of JSON
 * Schema (type, properties, required, additionalProperties, items, enum, const, min/max,
 * minLength/maxLength, minItems/maxItems, anyOf). Keywords it doesn't know are ignored, so a
 * richer schema still checks what it can. Both sides check: the friend's Beluga before sending,
 * and yours again on arrival (never trusting the other side). Browser-safe.
 */

type Schema = Record<string, unknown>;

const MAX_DEPTH = 24;
const MAX_PROBLEMS = 12;

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

function matchesType(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  const actual = typeOf(value);
  return types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

const isSchema = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

function check(value: unknown, schema: Schema, at: string, out: string[], depth: number): void {
  if (out.length >= MAX_PROBLEMS) return;
  if (depth > MAX_DEPTH) {
    out.push(`${at}: nested too deeply`);
    return;
  }
  const where = at || 'the result';
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((s) => {
      const sub: string[] = [];
      if (isSchema(s)) check(value, s, at, sub, depth + 1);
      return sub.length === 0;
    });
    if (!ok) out.push(`${where}: matches none of the allowed shapes`);
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    out.push(`${where}: expected ${Array.isArray(schema.type) ? schema.type.join(' or ') : String(schema.type)}, got ${typeOf(value)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${where}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${where}: must be ${JSON.stringify(schema.const)}`);
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.push(`${where}: below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.push(`${where}: above ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) out.push(`${where}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) out.push(`${where}: longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) out.push(`${where}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) out.push(`${where}: more than ${schema.maxItems} items`);
    if (isSchema(schema.items)) value.forEach((item, i) => check(item, schema.items as Schema, `${at}[${i}]`, out, depth + 1));
  }
  if (isSchema(value) && !Array.isArray(value)) {
    const props = isSchema(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === 'string' && !(key in value)) out.push(`${at ? `${at}.` : ''}${key}: missing`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = props[key];
      if (isSchema(sub)) check(v, sub, at ? `${at}.${key}` : key, out, depth + 1);
      else if (schema.additionalProperties === false) out.push(`${at ? `${at}.` : ''}${key}: not allowed`);
      else if (isSchema(schema.additionalProperties)) check(v, schema.additionalProperties, at ? `${at}.${key}` : key, out, depth + 1);
    }
  }
}

/** Problems with `value` against `schema` (empty: it fits). */
export function validate(value: unknown, schema: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  check(value, schema as Schema, '', out, 0);
  return out.slice(0, MAX_PROBLEMS);
}

/** A made-up value of the schema's shape (the demo's simulated friends answer with it). */
export function sample(schema: unknown, depth = 0): unknown {
  if (!isSchema(schema) || depth > 8) return null;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return sample(schema.anyOf[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'object': {
      const props = isSchema(schema.properties) ? schema.properties : {};
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sample(v, depth + 1)]));
    }
    case 'array':
      return [sample(schema.items, depth + 1)];
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return true;
    case 'string':
      return 'ok';
    default:
      return null;
  }
}
