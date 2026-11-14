/** CORS-safe image loading helpers shared by the texture, tile and heightmap loaders. */

export function loadImage(url: string, signal?: AbortSignal, timeoutMs = 15_000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous'; // required so the canvas / WebGL upload is not tainted
    img.decoding = 'async';

    const finish = (err?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      img.onload = null;
      img.onerror = null;
      if (err) {
        img.src = '';
        reject(err);
      } else {
        resolve(img);
      }
    };
    const onAbort = () => finish(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new Error(`Timed out loading ${url}`)), timeoutMs);

    img.onload = () => finish();
    img.onerror = () => finish(new Error(`Failed to load ${url}`));
    signal?.addEventListener('abort', onAbort, { once: true });
    img.src = url;
  });
}

export async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Run async jobs with bounded concurrency. */
export async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}
