import { type EmbeddingProviderModelInfo } from "../../config/schema.js";

import { type ProviderCredentials } from "../detector.js";
import {
  BaseEmbeddingProvider,
  type EmbeddingBatchResult,
  type EmbeddingResult,
} from "../provider-types.js";

export class GoogleEmbeddingProvider extends BaseEmbeddingProvider<EmbeddingProviderModelInfo["google"]> {
  private static readonly BATCH_SIZE = 20;

  public constructor(
    credentials: ProviderCredentials,
    modelInfo: EmbeddingProviderModelInfo["google"]
  ) {
    super(credentials, modelInfo);
  }

  public async embedQuery(query: string): Promise<EmbeddingResult> {
    const result = await this.embedWithTaskType(
      [this.applyTaskPrefix(query, "query")],
      this.resolveTaskType("query")
    );
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public async embedDocument(document: string): Promise<EmbeddingResult> {
    const result = await this.embedWithTaskType(
      [this.applyTaskPrefix(document, "document")],
      this.resolveTaskType("document")
    );
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const taskType = this.resolveTaskType("document");
    return this.embedWithTaskType(
      texts.map((text) => this.applyTaskPrefix(text, "document")),
      taskType
    );
  }

  // gemini-embedding-2 (and future prompt-prefixed models) declare `taskPrefix`
  // in the catalog instead of using the taskType API parameter, which the v2
  // model rejects. Prefixes follow the documented asymmetric retrieval format:
  // queries get `task: ... | query: ...`, documents get `title: ... | text: ...`.
  private applyTaskPrefix(text: string, kind: "query" | "document"): string {
    if (!("taskPrefix" in this.modelInfo) || !this.modelInfo.taskPrefix) {
      return text;
    }
    return this.modelInfo.taskPrefix[kind] + text;
  }

  private resolveTaskType(kind: "query" | "document"): string | undefined {
    if ("taskPrefix" in this.modelInfo) {
      return undefined;
    }
    if (!("taskAble" in this.modelInfo) || !this.modelInfo.taskAble) {
      return undefined;
    }
    return kind === "query" ? "CODE_RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  }

  private async embedWithTaskType(
    texts: string[],
    taskType?: string
  ): Promise<EmbeddingBatchResult> {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += GoogleEmbeddingProvider.BATCH_SIZE) {
      batches.push(texts.slice(i, i + GoogleEmbeddingProvider.BATCH_SIZE));
    }

    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const requests = batch.map((text) => ({
          model: `models/${this.modelInfo.model}`,
          content: {
            parts: [{ text }],
          },
          taskType,
          outputDimensionality: this.modelInfo.dimensions,
        }));

        const response = await fetch(
          `${this.credentials.baseUrl}/models/${this.modelInfo.model}:batchEmbedContents`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(this.credentials.apiKey && { "x-goog-api-key": this.credentials.apiKey }),
            },
            body: JSON.stringify({ requests }),
          }
        );

        if (!response.ok) {
          const error = (await response.text()).slice(0, 500);
          throw new Error(`Google embedding API error: ${response.status} - ${error}`);
        }

        const data = (await response.json()) as {
          embeddings: Array<{ values: number[] }>;
        };

        return {
          embeddings: data.embeddings.map((e) => e.values),
          tokensUsed: batch.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
        };
      })
    );

    return {
      embeddings: batchResults.flatMap((r) => r.embeddings),
      totalTokensUsed: batchResults.reduce((sum, r) => sum + r.tokensUsed, 0),
    };
  }
}
