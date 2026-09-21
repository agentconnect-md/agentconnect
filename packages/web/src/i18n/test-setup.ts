import { vi } from 'vitest'

// Existing component tests render directly through React DOM. Wrap those entry points once so
// localized components can enter the migration without changing every test helper at the same time.
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>()
  const { renderWithIntl } = await import('./test-utils')

  return {
    ...actual,
    createRoot(...args: Parameters<typeof actual.createRoot>) {
      const root = actual.createRoot(...args)
      return {
        render(children: Parameters<typeof root.render>[0]) {
          root.render(renderWithIntl(children))
        },
        unmount() {
          root.unmount()
        }
      }
    },
    hydrateRoot(
      container: Parameters<typeof actual.hydrateRoot>[0],
      initialChildren: Parameters<typeof actual.hydrateRoot>[1],
      options?: Parameters<typeof actual.hydrateRoot>[2]
    ) {
      const root = actual.hydrateRoot(container, renderWithIntl(initialChildren), options)
      return {
        render(children: Parameters<typeof root.render>[0]) {
          root.render(renderWithIntl(children))
        },
        unmount() {
          root.unmount()
        }
      }
    }
  }
})

vi.mock('react-dom/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/server')>()
  const { renderWithIntl } = await import('./test-utils')

  return {
    ...actual,
    renderToStaticMarkup(
      children: Parameters<typeof actual.renderToStaticMarkup>[0],
      options?: Parameters<typeof actual.renderToStaticMarkup>[1]
    ) {
      return actual.renderToStaticMarkup(renderWithIntl(children), options)
    },
    renderToString(children: Parameters<typeof actual.renderToString>[0], options?: never) {
      return actual.renderToString(renderWithIntl(children), options)
    }
  }
})
