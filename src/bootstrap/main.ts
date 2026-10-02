import { ApplyChangeSet } from '../application/apply-change-set';
import { CompactConversation } from '../application/compact-conversation';
import { ConversationCompactor } from '../application/conversation-compactor';
import { ConversationLog } from '../application/conversation-log';
import {
  DeleteSession,
  ListSessions,
  OpenSession,
  RestoreLatestSession,
  StartNewConversation,
} from '../application/conversation-session';
import { ExportSession, ImportSession, ListSessionExports } from '../application/session-exchange';
import { HandleAssistantRequest } from '../application/handle-assistant-request';
import { OperationLock } from '../application/operation-lock';
import { PendingChanges } from '../application/pending-change';
import { PreviewChangeSetFile } from '../application/preview-change-set-file';
import { RejectChangeSet } from '../application/reject-change-set';
import { UndoChangeSet } from '../application/undo-change-set';
import { ReviewAppliedChange } from '../application/review-applied-change';
import { WebSearchApproval } from '../application/web-search-approval';
import { createUuid } from '../infrastructure/browser/uuid';
import { OllamaAgent } from '../infrastructure/ollama/ollama-agent';
import { OllamaClient } from '../infrastructure/ollama/ollama-client';
import { OllamaSummarizer } from '../infrastructure/ollama/ollama-summarizer';
import { preloadOllamaModel } from '../infrastructure/ollama/ollama-preload';
import { OverleafHookContractError } from '../infrastructure/overleaf/codemirror-api';
import { OverleafEditorAdapter } from '../infrastructure/overleaf/overleaf-editor-adapter';
import { OverleafEditorBridge } from '../infrastructure/overleaf/overleaf-editor-bridge';
import {
  getCsrfToken,
  getPageIdentity,
  MissingPageMetadataError,
} from '../infrastructure/overleaf/overleaf-page';
import { OverleafProjectAdapter } from '../infrastructure/overleaf/overleaf-project-adapter';
import { OverleafProjectFiles } from '../infrastructure/overleaf/overleaf-project-files';
import {
  OverleafStore,
  OverleafStoreContractError,
  StoreKey,
} from '../infrastructure/overleaf/overleaf-store';
import { IndexedDbSessionRepository } from '../infrastructure/persistence/indexed-db-session-repository';
import { ProjectSessionArchive } from '../infrastructure/persistence/project-session-archive';
import { LocalStoragePanelSize } from '../infrastructure/persistence/local-storage-panel-size';
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
  const files = new OverleafProjectFiles({
    store,
    fetch: window.fetch.bind(window),
    projectId: identity.projectId,
    csrfToken: getCsrfToken(window.document),
  });
  const project = new OverleafProjectAdapter({ window, store, bridge, files });
  const newId = (): string => createUuid(window.crypto);
  const sessions = new IndexedDbSessionRepository(window, identity);
  const conversation = new ConversationLog({ sessions, newId, now: () => Date.now() });
  const pendingChanges = new PendingChanges(conversation);
  const createController = (): AbortController => new AbortController();
  const lock = new OperationLock(createController);
  const compactor = new ConversationCompactor({
    agent,
    summarizer: new OllamaSummarizer(client),
    conversation,
    newId,
    now: () => new Date(),
  });

  const handleRequest = new HandleAssistantRequest({
    agent,
    project,
    editor,
    conversation,
    pendingChanges,
    lock,
    newId,
    createController,
    compactor,
    webSearch: null,
  });
  const review = new ReviewAppliedChange({ project, conversation, handleRequest });
  const sessionDeps = { sessions, conversation, pendingChanges, editor, lock };
  const changeSetDeps = { project, editor, pendingChanges, review };
  const exchangeDeps = {
    ...sessionDeps,
    archive: new ProjectSessionArchive(files),
    project,
    scope: identity,
    newId,
    now: () => Date.now(),
  };

  const controller = new AssistantController({
    handleRequest,
    applyChange: new ApplyChangeSet({ ...changeSetDeps, conversation, lock }),
    lock,
    rejectChange: new RejectChangeSet({ ...changeSetDeps, lock }),
    previewChange: new PreviewChangeSetFile({
      project,
      editor,
      pendingChanges,
      conversation,
      lock,
    }),
    undoChange: new UndoChangeSet({ project, editor, conversation, lock, newId }),
    compactConversation: new CompactConversation({ compactor, conversation, lock }),
    restoreSession: new RestoreLatestSession(sessionDeps),
    startNewConversation: new StartNewConversation(sessionDeps),
    listSessions: new ListSessions(sessionDeps),
    openSession: new OpenSession(sessionDeps),
    deleteSession: new DeleteSession(sessionDeps),
    exportSession: new ExportSession(exchangeDeps),
    listSessionExports: new ListSessionExports(exchangeDeps),
    importSession: new ImportSession(exchangeDeps),
    webSearchApproval: new WebSearchApproval({ conversation, newId }),
    conversation,
  });

  void controller.attach(
    new AssistantView(window.document, controller, new LocalStoragePanelSize(window)),
  );
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
  | MissingPageMetadataError
  | OverleafHookContractError
  | OverleafStoreContractError {
  return (
    error instanceof ConfigurationError ||
    error instanceof MissingPageMetadataError ||
    error instanceof OverleafHookContractError ||
    error instanceof OverleafStoreContractError
  );
}

start(window);
