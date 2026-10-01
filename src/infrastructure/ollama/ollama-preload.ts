import {
  AssistantHttpError,
  AssistantTimeoutError,
  AssistantUnreachableError,
} from '../../ports/errors';
import type { OllamaClient } from './ollama-client';

export async function preloadOllamaModel(client: OllamaClient): Promise<void> {
  try {
    await client.loadModel();
  } catch (error) {
    if (!isLoadFailure(error)) throw error;
    console.debug('[overleaf-ai-assistant] the model could not be preloaded', error);
  }
}

function isLoadFailure(
  error: unknown,
): error is AssistantUnreachableError | AssistantTimeoutError | AssistantHttpError {
  return (
    error instanceof AssistantUnreachableError ||
    error instanceof AssistantTimeoutError ||
    error instanceof AssistantHttpError
  );
}
