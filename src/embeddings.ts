interface Embedder {
  (text: string, options: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array }>;
}

let embedder: Embedder | null = null;

export async function getEmbedder(): Promise<Embedder> {
  if (embedder) return embedder;
  const { pipeline } = await import('@huggingface/transformers');
  embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'fp32',
  }) as unknown as Embedder;
  return embedder;
}

export async function embed(text: string): Promise<number[]> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}
