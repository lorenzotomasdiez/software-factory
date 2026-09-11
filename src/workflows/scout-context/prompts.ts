/** Replaces {{KEY}} tokens; unknown keys become empty rather than erroring. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

/** The prompt file's first Markdown heading, used as the scout/reviewer's display title. */
export function promptTitle(template: string): string {
  const match = template.match(/^#\s*(.+)$/m);
  return match ? match[1].trim() : "agent";
}
