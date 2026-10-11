export interface PrismaSchemaField {
  name: string;
  type: string;
  baseType: string;
  optional: boolean;
  list: boolean;
  kind: 'scalar' | 'relation';
  attributes: string;
  isId: boolean;
  relation?: {
    target: string;
    fields: string[];
    references: string[];
    onDelete?: string;
    name?: string;
  };
  line: number;
}

export interface PrismaSchemaModel {
  name: string;
  fields: PrismaSchemaField[];
  line: number;
}

interface Attribute {
  name: string;
  args?: string;
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const scalarTypes = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
]);
const fieldAttributes = new Set([
  'id',
  'default',
  'unique',
  'relation',
  'map',
  'updatedAt',
  'ignore',
]);
const blockAttributes = new Set(['id', 'unique', 'index', 'fulltext', 'map', 'schema']);
const referentialActions = new Set(['Cascade', 'Restrict', 'NoAction', 'SetNull', 'SetDefault']);

/** A deliberately limited, line-oriented parser. Unsupported syntax must fail lint closed. */
export function parsePrismaSchema(source: string): PrismaSchemaModel[] {
  const models: PrismaSchemaModel[] = [];
  const enums = new Set<string>();
  const names = new Set<string>();
  const compositeIds = new Map<string, string[]>();
  let block: { kind: string; name: string; line: number; values: Set<string> } | undefined;
  let current: PrismaSchemaModel | undefined;

  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = stripLineComment(raw, lineNumber).trim();
    if (!line) continue;

    if (!block) {
      const start = /^(model|enum|generator|datasource)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(
        line,
      );
      if (!start) fail(lineNumber, 'Expected a supported block declaration on its own line');
      if (names.has(start[2])) fail(lineNumber, `Duplicate declaration ${start[2]}`);
      names.add(start[2]);
      block = { kind: start[1], name: start[2], line: lineNumber, values: new Set() };
      if (block.kind === 'model') {
        current = { name: block.name, fields: [], line: lineNumber };
        models.push(current);
      } else if (block.kind === 'enum') {
        enums.add(block.name);
      }
      continue;
    }

    if (line === '}') {
      block = undefined;
      current = undefined;
      continue;
    }
    checkBalanced(line, lineNumber);

    if (block.kind === 'generator' || block.kind === 'datasource') {
      const property = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
      if (!property) fail(lineNumber, 'Expected a configuration property on one line');
      if (block.values.has(property[1])) fail(lineNumber, `Duplicate property ${property[1]}`);
      block.values.add(property[1]);
      continue;
    }

    if (line.startsWith('@@')) {
      const attributes = parseAttributes(line, lineNumber, '@@');
      if (attributes.length !== 1) fail(lineNumber, 'Use one block attribute per line');
      const attr = attributes[0];
      if (
        !blockAttributes.has(attr.name) ||
        (block.kind === 'enum' && !['map', 'schema'].includes(attr.name))
      ) {
        fail(lineNumber, `Unsupported block attribute @@${attr.name}`);
      }
      if (attr.args === undefined) fail(lineNumber, `Missing arguments for @@${attr.name}`);
      if (attr.name === 'id') {
        if (compositeIds.has(block.name)) fail(lineNumber, 'Duplicate @@id');
        compositeIds.set(block.name, parseIdentifiers(splitArguments(attr.args)[0], lineNumber));
      }
      continue;
    }

    if (block.kind === 'enum') {
      const value = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(line);
      if (!value) fail(lineNumber, 'Unsupported enum value');
      if (block.values.has(value[1])) fail(lineNumber, `Duplicate enum value ${value[1]}`);
      block.values.add(value[1]);
      for (const attr of parseAttributes(value[2].trim(), lineNumber)) {
        if (attr.name !== 'map' || attr.args === undefined)
          fail(lineNumber, 'Only @map is supported on enum values');
      }
      continue;
    }

    const field =
      /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\?|\[\])?(?:\s+(.*))?$/.exec(line);
    if (!field || !current)
      fail(lineNumber, 'Unsupported field declaration; use one complete field per line');
    if (current.fields.some((item) => item.name === field[1]))
      fail(lineNumber, `Duplicate field ${field[1]}`);
    const attributes = field[4]?.trim() ?? '';
    const parsed = parseAttributes(attributes, lineNumber);
    for (const attr of parsed) {
      if (!fieldAttributes.has(attr.name) && !/^db\.[A-Za-z_][A-Za-z0-9_]*$/.test(attr.name)) {
        fail(lineNumber, `Unsupported field attribute @${attr.name}`);
      }
    }
    current.fields.push({
      name: field[1],
      type: field[2] + (field[3] ?? ''),
      baseType: field[2],
      optional: field[3] === '?',
      list: field[3] === '[]',
      kind: 'scalar',
      attributes,
      isId: parsed.some((attr) => attr.name === 'id'),
      line: lineNumber,
    });
  }

  if (block) fail(block.line, `Unclosed ${block.kind} ${block.name}`);
  if (!models.length) fail(1, 'No model declarations found');
  const byName = new Map(models.map((model) => [model.name, model]));
  for (const model of models) {
    for (const field of model.fields) {
      if (
        !scalarTypes.has(field.baseType) &&
        !enums.has(field.baseType) &&
        !byName.has(field.baseType)
      ) {
        fail(field.line, `Unsupported or unknown field type ${field.baseType}`);
      }
      if (byName.has(field.baseType)) field.kind = 'relation';
    }
  }
  for (const model of models) {
    for (const name of compositeIds.get(model.name) ?? []) {
      const field = model.fields.find((item) => item.name === name);
      if (!field || field.kind !== 'scalar')
        fail(model.line, `Unknown or non-scalar @@id field ${name}`);
      field.isId = true;
    }
    for (const field of model.fields) {
      const relation = parseAttributes(field.attributes, field.line).find(
        (attr) => attr.name === 'relation',
      );
      if (field.kind === 'relation') {
        field.relation = parseRelation(field, relation);
        const target = byName.get(field.baseType)!;
        for (const name of field.relation.fields) {
          if (!model.fields.some((item) => item.name === name && item.kind === 'scalar'))
            fail(field.line, `Unknown relation field ${name}`);
        }
        for (const name of field.relation.references) {
          if (!target.fields.some((item) => item.name === name && item.kind === 'scalar'))
            fail(field.line, `Unknown relation reference ${name}`);
        }
      } else if (relation) {
        fail(field.line, '@relation requires a model field type');
      }
    }
  }
  return models;
}

function parseRelation(
  field: PrismaSchemaField,
  attribute?: Attribute,
): NonNullable<PrismaSchemaField['relation']> {
  const relation: NonNullable<PrismaSchemaField['relation']> = {
    target: field.baseType,
    fields: [],
    references: [],
  };
  if (!attribute) return relation;
  if (attribute.args === undefined) fail(field.line, '@relation requires arguments');
  const seen = new Set<string>();
  for (const [index, argument] of splitArguments(attribute.args).entries()) {
    const named = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(argument);
    const key = named?.[1] ?? (index === 0 ? 'name' : '');
    const value = named?.[2] ?? argument;
    if (seen.has(key)) fail(field.line, `Duplicate relation argument ${key}`);
    seen.add(key);
    if (key === 'fields' || key === 'references')
      relation[key] = parseIdentifiers(value, field.line);
    else if (key === 'onDelete' || key === 'onUpdate') {
      if (!referentialActions.has(value))
        fail(field.line, `Unsupported referential action ${value}`);
      if (key === 'onDelete') relation.onDelete = value;
    } else if (['name', 'map'].includes(key)) {
      if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) fail(field.line, `Expected quoted relation ${key}`);
      let parsed: string;
      try {
        parsed = JSON.parse(value) as string;
      } catch {
        fail(field.line, `Invalid quoted relation ${key}`);
      }
      if (key === 'name') relation.name = parsed;
    } else fail(field.line, `Unsupported relation argument ${key || argument}`);
  }
  if (relation.fields.length !== relation.references.length)
    fail(field.line, 'Relation fields and references must have matching lengths');
  return relation;
}

function parseIdentifiers(value: string | undefined, line: number): string[] {
  if (!value || !/^\[.*\]$/.test(value)) fail(line, 'Expected a nonempty identifier list');
  const names = value
    .slice(1, -1)
    .split(',')
    .map((name) => name.trim());
  if (names.some((name) => !identifier.test(name)) || new Set(names).size !== names.length) {
    fail(line, 'Unsupported or duplicate identifier in field list');
  }
  return names;
}

function parseAttributes(source: string, line: number, prefix = '@'): Attribute[] {
  const attributes: Attribute[] = [];
  let rest = source.trim();
  while (rest) {
    const match = new RegExp(
      `^${prefix}([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)?)`,
    ).exec(rest);
    if (!match) fail(line, 'Unsupported attribute syntax or multiple fields on one line');
    const name = match[1];
    if (attributes.some((attr) => attr.name === name))
      fail(line, `Duplicate attribute ${prefix}${name}`);
    rest = rest.slice(match[0].length);
    let args: string | undefined;
    if (rest.startsWith('(')) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      let end = -1;
      for (let index = 0; index < rest.length; index += 1) {
        const char = rest[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '(') depth += 1;
        else if (char === ')' && --depth === 0) {
          end = index;
          break;
        }
      }
      if (end < 0) fail(line, 'Unclosed attribute; multiline attributes are unsupported');
      args = rest.slice(1, end);
      rest = rest.slice(end + 1);
    }
    if (rest && !/^\s/.test(rest)) fail(line, 'Attributes must be separated by whitespace');
    attributes.push({ name, args });
    rest = rest.trim();
  }
  return attributes;
}

function splitArguments(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = source.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function stripLineComment(source: string, line: number): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '/' && source[index + 1] === '/') return source.slice(0, index);
    else if (char === '/' && source[index + 1] === '*')
      fail(line, 'Block comments are unsupported; use // comments');
  }
  if (quoted) fail(line, 'Unclosed quoted string');
  return source;
}

function checkBalanced(source: string, line: number): void {
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (const char of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '(' || char === '[') stack.push(char);
    else if (char === ')' || char === ']') {
      if (stack.pop() !== (char === ')' ? '(' : '[')) fail(line, 'Mismatched delimiters');
    } else if (char === '{' || char === '}')
      fail(line, 'Block braces must be on declaration/closing lines');
  }
  if (stack.length) fail(line, 'Unclosed delimiter; multiline declarations are unsupported');
}

function fail(line: number, message: string): never {
  throw new Error(`Prisma schema line ${line}: ${message}`);
}
