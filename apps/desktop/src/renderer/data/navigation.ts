const guards = new Set<() => Promise<boolean>>();
export function registerNavigationGuard(guard: () => Promise<boolean>) {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}
export async function checkNavigationGuards() {
  for (const guard of guards) if (!(await guard())) return false;
  return true;
}
