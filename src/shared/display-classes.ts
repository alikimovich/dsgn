/**
 * Compiler-generated style-scope classes are selector plumbing, not useful
 * element identity. Keep this predicate shared by every human-facing class
 * list, including the browser bridge source generated in main.
 */
export const SCOPE_CLASS_PATTERN =
  /^(?:s|svelte|sc|css|jsx|astro|emotion)-(?=[A-Za-z0-9_]{4,}$)(?:(?=[A-Za-z0-9_]*\d)|(?=[A-Za-z0-9_]*[a-z])(?=[A-Za-z0-9_]*[A-Z]))[A-Za-z0-9_]+$/

export function isScopeClass(cls: string): boolean {
  return SCOPE_CLASS_PATTERN.test(cls)
}
