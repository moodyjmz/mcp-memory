interface Embedder {
  (text: string, options: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array }>;
}

// The load is shared: the startup warm-up and the first heal or query otherwise
// each load their own copy of the model. A failed load is retried on the next call.
let loading: Promise<Embedder> | null = null;

export function getEmbedder(): Promise<Embedder> {
  loading ??= (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    return await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'fp32',
    }) as unknown as Embedder;
  })().catch(err => {
    loading = null;
    throw err;
  });
  return loading;
}

export async function embed(text: string): Promise<number[]> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}
