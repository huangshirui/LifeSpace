export const REFERENCE_LABEL_TEMPLATE_MAX_LENGTH = 200;
export const REFERENCE_LABEL_MAX_PLACEHOLDERS = 8;
export const REFERENCE_LABEL_OUTPUT_MAX_LENGTH = 200;

const FIELD_KEY = /^[a-z][A-Za-z0-9]{0,62}$/;

export type ReferenceLabelDefinition =
  | { field: string }
  | { template: string };

export type ReferenceLabelTemplateSegment =
  | { kind: "literal"; value: string }
  | { kind: "field"; field: string };

export type ParsedReferenceLabelTemplate = {
  fields: string[];
  placeholderCount: number;
  segments: ReferenceLabelTemplateSegment[];
};

export function parseReferenceLabelTemplate(template: string): ParsedReferenceLabelTemplate | null {
  if (!template || template.length > REFERENCE_LABEL_TEMPLATE_MAX_LENGTH) return null;

  const fields: string[] = [];
  const segments: ReferenceLabelTemplateSegment[] = [];
  let placeholderCount = 0;
  let position = 0;

  while (position < template.length) {
    const open = template.indexOf("{", position);
    const strayClose = template.indexOf("}", position);

    if (open === -1) {
      if (strayClose !== -1) return null;
      if (position < template.length) segments.push({ kind: "literal", value: template.slice(position) });
      break;
    }
    if (strayClose !== -1 && strayClose < open) return null;
    if (open > position) segments.push({ kind: "literal", value: template.slice(position, open) });

    const close = template.indexOf("}", open + 1);
    if (close === -1) return null;
    const field = template.slice(open + 1, close);
    if (!FIELD_KEY.test(field)) return null;

    placeholderCount += 1;
    if (placeholderCount > REFERENCE_LABEL_MAX_PLACEHOLDERS) return null;
    fields.push(field);
    segments.push({ kind: "field", field });
    position = close + 1;
  }

  if (placeholderCount === 0) return null;
  return {
    fields: [...new Set(fields)],
    placeholderCount,
    segments,
  };
}
