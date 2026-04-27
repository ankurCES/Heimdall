// lazy.ts — v1.4.14 lazy-loading helper for named-export route components.
//
// React.lazy expects a module whose default export is the component.
// Almost every page in this app uses named exports (`export function
// FooPage()`) which keeps tree-shaking honest. This helper wraps a
// dynamic `import()` so React.lazy can consume named exports without
// each page file needing a default re-export.
//
// Usage:
//   const FooPage = lazyNamed(() => import('./pages/foo/FooPage'), 'FooPage')
//
// The named export is plucked at module-load time, so a typo in the
// export name throws a clear error rather than rendering a broken
// component silently.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

export function lazyNamed<T extends ComponentType<unknown>>(
  loader: () => Promise<Record<string, unknown>>,
  exportName: string
): LazyExoticComponent<T> {
  return lazy(async () => {
    const mod = await loader()
    const Comp = mod[exportName] as T | undefined
    if (!Comp) {
      throw new Error(`lazyNamed: '${exportName}' not found in module`)
    }
    return { default: Comp }
  })
}
