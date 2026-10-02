import { AgentLoop } from '../application/agent-loop';
import { ApplyChangeSet } from '../application/apply-change-set';
import { CompactConversation } from '../application/compact-conversation';
import { ConversationAgent } from '../application/conversation-agent';
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
import { ReadContextUsage } from '../application/read-context-usage';
import { ProjectTools } from '../application/project-tools';
import { RejectChangeSet } from '../application/reject-change-set';
import { UndoChangeSet } from '../application/undo-change-set';
import { ReviewAppliedChange } from '../application/review-applied-change';
import { WebSearchApproval } from '../application/web-search-approval';
import { WebSearchTool } from '../application/web-search-tool';
import { createAgentPolicies } from '../domain/agent-policy';
import type { SessionScope } from '../domain/session';
import { createUuid } from '../infrastructure/browser/uuid';
import { ExaWebSearch } from '../infrastructure/mcp/exa-web-search';
import { McpClient } from '../infrastructure/mcp/mcp-client';
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
import { OverleafSessionArchive } from '../infrastructure/overleaf/overleaf-session-archive';
import { LocalStoragePanelPreferences } from '../infrastructure/persistence/local-storage-panel-preferences';
import { AssistantController } from '../presentation/assistant-controller';
import { AssistantView } from '../presentation/assistant-view';
import {
  ConfigurationError,
  loadConfig,
  type AssistantConfig,
  type WebSearchConfig,
} from './config';

const MCP_CLIENT_INFO = { name: 'overleaf-ai-assistant', version: '1.0.0' };

function createWebSearch(
  window: Window & typeof globalThis,
  config: WebSearchConfig,
  approval: WebSearchApproval,
): WebSearchTool {
  const client = new McpClient(config.endpoint, MCP_CLIENT_INFO, window.fetch.bind(window));
  return new WebSearchTool({ search: new ExaWebSearch(client), approval });
}

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
  const scope: SessionScope = { userId: identity.userId, projectId: identity.projectId };
  const sessions = new IndexedDbSessionRepository(window, scope);
  const conversation = new ConversationLog({ sessions, newId, now: () => Date.now() });
  const pendingChanges = new PendingChanges({ conversation, editor });
  const createController = (): AbortController => new AbortController();
  const lock = new OperationLock(createController);
  const compactor = new ConversationCompactor({
    agent,
    summarizer: new OllamaSummarizer(client),
    conversation,
    newId,
    now: () => new Date(),
  });

  const webSearchApproval = new WebSearchApproval({ conversation, newId });
  const webSearch =
    config.webSearch === null ? null : createWebSearch(window, config.webSearch, webSearchApproval);
  const loop = new AgentLoop({
    agent,
    compactor,
    tools: new ProjectTools(project, createController),
    webSearch,
    policies: createAgentPolicies({ webSearch: webSearch !== null }),
  });
  const conversationAgent = new ConversationAgent({
    loop,
    project,
    editor,
    conversation,
    pendingChanges,
    lock,
    newId,
  });
  const handleRequest = new HandleAssistantRequest({ conversationAgent, conversation, lock });
  const review = new ReviewAppliedChange({ project, conversation, conversationAgent });
  const sessionDeps = { sessions, conversation, pendingChanges, lock };
  const changeSetDeps = { project, conversation, editor, pendingChanges, review };
  const exchangeDeps = {
    ...sessionDeps,
    archive: new OverleafSessionArchive(files),
    project,
    scope,
    newId,
    now: () => Date.now(),
  };

  const controller = new AssistantController({
    handleRequest,
    readContextUsage: new ReadContextUsage({ conversation, agent }),
    applyChange: new ApplyChangeSet({ ...changeSetDeps, lock }),
    lock,
    rejectChange: new RejectChangeSet({ ...changeSetDeps, lock }),
    previewChange: new PreviewChangeSetFile({
      project,
      conversation,
      editor,
      pendingChanges,
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
    webSearchApproval,
    conversation,
  });

  void controller.attach(
    new AssistantView(window.document, controller, new LocalStoragePanelPreferences(window)),
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
