import { AssistantTimeoutError, AssistantTransportError } from '../../ports/errors';
import type { OllamaClient } from './ollama-client';

export function preloadOllamaModel(client: OllamaClient): void {
  client.loadModel().catch((error: unknown) => {
    if (!(error instanceof AssistantTransportError || error instanceof AssistantTimeoutError)) {
      throw error;
    }
    console.debug('[overleaf-ai-assistant] the model could not be preloaded', error);
  });
}
