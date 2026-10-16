/**
 * Loader hook that resolves the host-provided `react` peer to the local stub.
 *
 * Only used by `client.test.mjs`, and only for the `react` specifier; every
 * other module resolves normally.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'react') {
    return { url: new URL('./react-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
