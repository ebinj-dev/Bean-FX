/** MY AI — id helper: prefixed, sortable, collision-safe within a process. */
let counter = 0;
export function newId(kind: string): string {
  return `myai_${kind}_${Date.now().toString(36)}_${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
