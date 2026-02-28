export type JinjaScalar = string | number | boolean | null | undefined;
export interface JinjaObject {
  [key: string]: JinjaValue;
}
export interface JinjaArray extends Array<JinjaValue> {}
export type JinjaValue = JinjaScalar | JinjaArray | JinjaObject;

export function renderJinjaTemplate(
  template: string,
  context: Record<string, JinjaValue>
): string {
  const loopPattern = /{%\s*for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*%}([\s\S]*?){%\s*endfor\s*%}/g;

  let rendered = template.replace(
    loopPattern,
    (_match: string, itemName: string, arrayName: string, body: string) => {
      const source = context[arrayName];
      if (!Array.isArray(source)) {
        throw new Error(`jinja render error: '${arrayName}' is not an array`);
      }

      return source
        .map((item) => renderJinjaTemplate(body, { ...context, [itemName]: item }))
        .join("");
    }
  );

  const variablePattern = /{{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*}}/g;
  rendered = rendered.replace(variablePattern, (_match: string, path: string) => {
    const value = resolvePath(path, context);
    if (value === null || value === undefined) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    throw new Error(`jinja render error: variable '${path}' is not scalar`);
  });

  return rendered;
}

function resolvePath(path: string, context: Record<string, JinjaValue>): JinjaValue {
  const keys = path.split(".");
  let cursor: JinjaValue = context;

  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, JinjaValue>)[key];
  }

  return cursor;
}
