import { ApplyDocumentChange } from '../application/apply-document-change';
import { ConversationLog } from '../application/conversation-log';
import { StartNewConversation } from '../application/conversation-session';
import { HandleAssistantRequest } from '../application/handle-assistant-request';
import { OperationLock } from '../application/operation-lock';
import { PendingChanges } from '../application/pending-change';
import { RejectDocumentChange } from '../application/reject-document-change';
import { ReviewAppliedChange } from '../application/review-applied-change';
import { createUuid } from '../infrastructure/browser/uuid';
import { OllamaAgent } from '../infrastructure/ollama/ollama-agent';
import { OllamaClient } from '../infrastructure/ollama/ollama-client';
import { preloadOllamaModel } from '../infrastructure/ollama/ollama-preload';
import { OverleafHookContractError } from '../infrastructure/overleaf/codemirror-api';
import { OverleafEditorAdapter } from '../infrastructure/overleaf/overleaf-editor-adapter';
import { OverleafEditorBridge } from '../infrastructure/overleaf/overleaf-editor-bridge';
import {
  getPageIdentity,
  MissingPageIdentityError,
} from '../infrastructure/overleaf/overleaf-page';
import { OverleafProjectAdapter } from '../infrastructure/overleaf/overleaf-project-adapter';
import {
  OverleafStore,
  OverleafStoreContractError,
  StoreKey,
} from '../infrastructure/overleaf/overleaf-store';
import { LocalStorageConversationRepository } from '../infrastructure/persistence/local-storage-conversation-repository';
import { AssistantController } from '../presentation/assistant-controller';
import { AssistantView } from '../presentation/assistant-view';
import { ConfigurationError, loadConfig, type AssistantConfig } from './config';

function compose(
  window: Window & typeof globalThis,
  config: AssistantConfig,
  bridge: OverleafEditorBridge,
  store: OverleafStore,
): void {
  const identity = getPageIdentity(window.document);
  const editor = new OverleafEditorAdapter(bridge);
  const client = new OllamaClient(
    {
      endpoint: config.ollamaEndpoint,
      model: config.model,
      stepTimeoutMs: config.agentStepTimeoutMs,
    },
    window.fetch.bind(window),
  );
  const agent = new OllamaAgent(client);
  const project = new OverleafProjectAdapter({
    window,
    store,
    bridge,
    fetch: window.fetch.bind(window),
    projectId: identity.projectId,
  });
  const conversation = new ConversationLog(
    new LocalStorageConversationRepository(window, identity),
  );
  const pendingChanges = new PendingChanges();
  const lock = new OperationLock(() => new AbortController());

  const handleRequest = new HandleAssistantRequest({
    agent,
    project,
    editor,
    conversation,
    pendingChanges,
    lock,
    newId: () => createUuid(window.crypto),
  });
  const review = new ReviewAppliedChange({ project, conversation, handleRequest });

  const controller = new AssistantController({
    handleRequest,
    applyChange: new ApplyDocumentChange({
      editor,
      project,
      pendingChanges,
      conversation,
      lock,
      review,
    }),
    lock,
    rejectChange: new RejectDocumentChange({ editor, pendingChanges, conversation }),
    startNewConversation: new StartNewConversation({
      conversation,
      pendingChanges,
      editor,
      lock,
    }),
    conversation,
  });

  void controller.attach(new AssistantView(window.document, controller));
  void preloadOllamaModel(client);
}

function start(window: Window & typeof globalThis): void {
  let store: OverleafStore | null = null;
  const getStore = (): OverleafStore => {
    store ??= OverleafStore.fromWindow(window);
    return store;
  };
  const bridge = new OverleafEditorBridge(() => getStore().getString(StoreKey.OpenDocId));
  const uninstall = bridge.install(window);
  bridge
    .whenReady()
    .then(() => loadConfig(window.fetch.bind(window)))
    .then((config) => {
      if (AssistantView.isMounted(window.document)) {
        uninstall();
        return;
      }
      compose(window, config, bridge, getStore());
    })
    .catch((error: unknown) => {
      if (!isStartupFailure(error)) throw error;
      uninstall();
      console.error('[overleaf-ai-assistant] not started:', error.message);
    });
}

function isStartupFailure(
  error: unknown,
): error is
  | ConfigurationError
  | MissingPageIdentityError
  | OverleafHookContractError
  | OverleafStoreContractError {
  return (
    error instanceof ConfigurationError ||
    error instanceof MissingPageIdentityError ||
    error instanceof OverleafHookContractError ||
    error instanceof OverleafStoreContractError
  );
}

start(window);
