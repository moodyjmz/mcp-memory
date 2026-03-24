let embedder = null;

export async function getEmbedder() {
  if (embedder) return embedder;
  const { pipeline } = await import('@huggingface/transformers');
  embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
  return embedder;
}

export async function embed(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}
