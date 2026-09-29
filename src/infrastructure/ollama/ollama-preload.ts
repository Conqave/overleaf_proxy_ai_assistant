import { AssistantTimeoutError, AssistantUnreachableError } from '../../ports/errors';
import type { OllamaClient } from './ollama-client';

export async function preloadOllamaModel(client: OllamaClient): Promise<void> {
  try {
    await client.loadModel();
  } catch (error) {
    if (!(error instanceof AssistantUnreachableError || error instanceof AssistantTimeoutError)) {
      throw error;
    }
    console.debug('[overleaf-ai-assistant] the model could not be preloaded', error);
  }
}
