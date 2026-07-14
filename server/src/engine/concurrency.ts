/**
 * Bounded-concurrency map over a list. Runs at most `limit` tasks at once —
 * workers pull from a shared cursor — so a large watchlist doesn't burst past
 * the quote provider's rate limit (Finnhub 60/min) or thrash CPU. Result order
 * and the PromiseSettledResult shape match `Promise.allSettled`.
 */
export async function mapSettledLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
