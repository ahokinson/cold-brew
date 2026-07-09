// Per-item failures are isolated: handler rejections land in the result
// slot as Error sentinels so one bad item can't abandon the rest of the pool.
export async function runWithConcurrencyLimit<TInput, TOutput>(
  items: TInput[],
  limit: number,
  handler: (item: TInput) => Promise<TOutput>,
  onProgress?: (completed: number, total: number) => void,
): Promise<Array<TOutput | Error>> {
  const results: Array<TOutput | Error> = new Array(items.length)
  let nextIndex = 0
  let completed = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++
      try {
        results[index] = await handler(items[index]!)
      } catch (error) {
        results[index] = error instanceof Error ? error : new Error(String(error))
      }
      completed++
      onProgress?.(completed, items.length)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

export async function runBatchesWithLimit<T>(
  items: string[],
  batchSize: number,
  maxConcurrent: number,
  handler: (batch: string[]) => Promise<T>,
  onProgress?: (completed: number, total: number) => void,
): Promise<Array<T | Error>> {
  const batches: string[][] = []
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize))
  }

  return runWithConcurrencyLimit(batches, maxConcurrent, handler, onProgress)
}
