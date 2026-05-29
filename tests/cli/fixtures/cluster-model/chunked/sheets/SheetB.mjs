// Synthetic circular-cluster fixture (SheetA ↔ SheetB) for per-sheet-eval tests.
export const SHEET_NAME = 'SheetB';
export const SHEET_DEPENDENCIES = ['SheetA'];
export function compute(ctx) {
  ctx.set('SheetB!c', ctx.get('SheetA!a') + ctx.get('SheetA!b')); // reads across the cluster
  ctx.set('SheetB!d', ctx.get('SheetB!c'));
}
