// Synthetic circular-cluster fixture (SheetA ↔ SheetB) for per-sheet-eval tests.
// SheetA reads SheetB!d; SheetB reads SheetA. Converges to a=50, b=50, c=100, d=100.
export const SHEET_NAME = 'SheetA';
export const SHEET_DEPENDENCIES = ['SheetB'];
export function compute(ctx) {
  ctx.set('SheetA!a', 50);                       // constant
  ctx.set('SheetA!b', ctx.get('SheetB!d') / 2);  // reads across the cluster
}
