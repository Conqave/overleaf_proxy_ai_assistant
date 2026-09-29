import { ApplyDocumentChange } from '../application/apply-document-change';
import { ConversationLog } from '../application/conversation-log';
import { StartNewConversation } from '../application/conversation-session';
import { HandleAssistantRequest } from '../application/handle-assistant-request';
import { PendingChanges } from '../application/pending-change';
import { RejectDocumentChange } from '../application/reject-document-change';
import { createUuid } from '../infrastructure/browser/uuid';
import { OllamaAssistant } from '../infrastructure/ollama/ollama-assistant';
import { OllamaClient } from '../infrastructure/ollama/ollama-client';
import { preloadOllamaModel } from '../infrastructure/ollama/ollama-preload';
import { OverleafEditorAdapter } from '../infrastructure/overleaf/overleaf-editor-adapter';
import { OverleafEditorBridge } from '../infrastructure/overleaf/overleaf-editor-bridge';
import {
  getPageIdentity,
  MissingPageIdentityError,
} from '../infrastructure/overleaf/overleaf-page';
import { LocalStorageConversationRepository } from '../infrastructure/persistence/local-storage-conversation-repository';
import { AssistantController } from '../presentation/assistant-controller';
import { AssistantView } from '../presentation/assistant-view';
import { ConfigurationError, loadConfig, type AssistantConfig } from './config';

function compose(
  window: Window & typeof globalThis,
  config: AssistantConfig,
  bridge: OverleafEditorBridge,
): void {
  const identity = getPageIdentity(window.document);
  const editor = new OverleafEditorAdapter(bridge, window.document);
  const client = new OllamaClient(
    {
      endpoint: config.ollamaEndpoint,
      model: config.model,
      contextTokens: config.contextTokens,
      timeoutMs: config.requestTimeoutMs,
    },
    window.fetch.bind(window),
  );
  const assistant = new OllamaAssistant(client);
  const conversation = new ConversationLog(
    new LocalStorageConversationRepository(window, identity),
  );
  const pendingChanges = new PendingChanges();

  const controller = new AssistantController({
    handleRequest: new HandleAssistantRequest({
      assistant,
      editor,
      conversation,
      pendingChanges,
      newId: () => createUuid(window.crypto),
    }),
    applyChange: new ApplyDocumentChange({ editor, pendingChanges }),
    rejectChange: new RejectDocumentChange({ editor, pendingChanges, conversation }),
    startNewConversation: new StartNewConversation({ conversation, pendingChanges, editor }),
    conversation,
  });

  void controller.attach(new AssistantView(window.document, controller));
  void preloadOllamaModel(client);
}

function start(window: Window & typeof globalThis): void {
  const bridge = new OverleafEditorBridge();
  const uninstall = bridge.install(window);
  bridge
    .whenReady()
    .then(() => loadConfig(window.fetch.bind(window)))
    .then((config) => {
      if (AssistantView.isMounted(window.document)) {
        uninstall();
        return;
      }
      compose(window, config, bridge);
    })
    .catch((error: unknown) => {
      if (!(error instanceof ConfigurationError || error instanceof MissingPageIdentityError)) {
        throw error;
      }
      uninstall();
      console.error('[overleaf-ai-assistant] not started:', error.message);
    });
}

start(window);
