export interface PrismaSchemaField {
  name: string;
  type: string;
  line: number;
}

export interface PrismaSchemaModel {
  name: string;
  fields: PrismaSchemaField[];
  line: number;
}

export function parsePrismaSchema(source: string): PrismaSchemaModel[] {
  const models: PrismaSchemaModel[] = [];
  const lines = source.split(/\r?\n/);
  let current: PrismaSchemaModel | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripLineComment(lines[index]).trim();
    if (!line) {
      continue;
    }

    if (!current) {
      const match = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
      if (match) {
        current = { name: match[1], fields: [], line: lineNumber };
      }
      continue;
    }

    if (line.startsWith('}')) {
      models.push(current);
      current = null;
      continue;
    }

    if (line.startsWith('@@') || line.startsWith('@')) {
      continue;
    }

    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+([^\s]+)/.exec(line);
    if (fieldMatch) {
      current.fields.push({
        name: fieldMatch[1],
        type: fieldMatch[2],
        line: lineNumber,
      });
    }
  }

  return models;
}

function stripLineComment(line: string): string {
  const index = line.indexOf('//');
  return index === -1 ? line : line.slice(0, index);
}
