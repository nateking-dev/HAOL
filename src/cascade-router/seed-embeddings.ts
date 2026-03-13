import { loadConfig } from "../config.js";
import {
  createPool,
  getPool,
  query,
  execute,
  destroy,
} from "../db/connection.js";
import { doltCommit } from "../db/dolt.js";
import { OpenAIEmbeddingProvider } from "./embedding-openai.js";

interface PendingUtterance {
  utterance_id: string;
  utterance_text: string;
}

async function main() {
  const config = loadConfig();
  try {
    getPool();
  } catch {
    createPool(config.dolt);
  }

  // Find utterances that need embedding
  const pending = await query<
    (PendingUtterance & import("mysql2/promise").RowDataPacket)[]
  >(
    `SELECT utterance_id, utterance_text
     FROM routing_utterances
     WHERE embedding_model = 'pending'
     ORDER BY utterance_id`,
  );

  if (pending.length === 0) {
    console.log("No pending utterances to embed.");
    await destroy();
    return;
  }

  console.log(`Found ${pending.length} utterances to embed.`);

  const embedder = new OpenAIEmbeddingProvider({
    modelId: "text-embedding-3-small",
    dimensions: 512,
  });

  const modelId = embedder.modelId();
  const texts = pending.map((u) => u.utterance_text);

  try {
    const embeddings = await embedder.embedBatch(texts);

    for (let i = 0; i < pending.length; i++) {
      await execute(
        `UPDATE routing_utterances
         SET embedding = ?, embedding_model = ?, embedding_dim = ?
         WHERE utterance_id = ?`,
        [
          JSON.stringify(embeddings[i]),
          modelId,
          embeddings[i].length,
          pending[i].utterance_id,
        ],
      );
      console.log(
        `  [${i + 1}/${pending.length}] ${pending[i].utterance_id}: "${pending[i].utterance_text.slice(0, 60)}..."`,
      );
    }

    await doltCommit({
      message: `seed: embeddings via ${modelId} (${pending.length} utterances)`,
      author: "haol-seed <haol@system>",
    });

    console.log(`Done. Embedded ${pending.length} utterances.`);
  } catch (err) {
    console.error("Embedding failed:", err);
    process.exit(1);
  }

  await destroy();
}

main().catch((err) => {
  console.error("Seed embeddings failed:", err);
  process.exit(1);
});
