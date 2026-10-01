import { AgentTool, type ProjectEdit } from '../domain/agent-action';
import { hasMistakesLeft } from '../domain/agent-policy';
import type { AgentTurn, CompileDiagnostic } from '../domain/agent-transcript';
import type {
  ConversationMessage,
  GreetingMessage,
  ProposalMessage,
  ReplyMessage,
  SystemRequestMessage,
  UserMessage,
} from '../domain/conversation';
import type { AgentPort, AgentWorkspace, ContextUsage } from '../ports/agent-port';
import type { CancellationSignal } from '../ports/cancellation';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import { acceptDecision, isAgentMistake, type AcceptedDecision } from './agent-decision';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import { AgentMistakeLimitError, EmptyRequestError } from './errors';
import { isGreetingOnly } from './greeting-policy';
import type { OperationLock } from './operation-lock';
import { PendingDocumentChange, type PendingChanges } from './pending-change';
import { ProjectTools } from './project-tools';
import { showProjectFile } from './show-project-file';

export type { ContextUsage } from '../ports/agent-port';

interface RequestRun {
  readonly epoch: number;
  readonly signal: CancellationSignal;
  readonly onProgress: (progress: AgentProgress) => void;
}

export const COMPILE_FIX_REQUEST =
  'Compiling the project after the applied change reports errors; fix the first error.';

export type AssistantRequestResult =
  { readonly kind: 'greeting'; readonly message: GreetingMessage } | AgentResult;

export type AgentResult =
  | {
      readonly kind: 'reply';
      readonly message: ReplyMessage;
      readonly contextUsage: ContextUsage;
    }
  | {
      readonly kind: 'proposal';
      readonly message: ProposalMessage;
      readonly changeId: string;
      readonly contextUsage: ContextUsage;
    };

export class HandleAssistantRequest {
  private readonly tools: ProjectTools;

  constructor(
    private readonly deps: {
      agent: AgentPort;
      project: ProjectPort;
      editor: EditorPort;
      conversation: ConversationLog;
      pendingChanges: PendingChanges;
      lock: OperationLock;
      newId: () => string;
    },
  ) {
    this.tools = new ProjectTools(deps.project);
  }

  async execute(
    text: string,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<AssistantRequestResult> {
    const request = text.trim();
    if (!request) throw new EmptyRequestError();
    return await this.deps.lock.run(async (signal) => {
      const message: UserMessage = { id: this.deps.newId(), role: 'user', text: request };
      const { history, epoch } = this.receive(message, onProgress);
      if (isGreetingOnly(request)) return { kind: 'greeting', message: this.greet() };
      return await this.runAgent(request, history, [], { epoch, signal, onProgress });
    });
  }

  async fixCompileErrors(
    diagnostics: readonly CompileDiagnostic[],
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<AgentResult> {
    this.deps.lock.assertHeld();
    const message: SystemRequestMessage = {
      id: this.deps.newId(),
      role: 'system',
      text: COMPILE_FIX_REQUEST,
    };
    const { history, epoch } = this.receive(message, onProgress);
    const compiled: AgentTurn = {
      kind: 'tool',
      call: { tool: AgentTool.Compile },
      result: { tool: AgentTool.Compile, diagnostics },
    };
    return await this.runAgent(COMPILE_FIX_REQUEST, history, [compiled], {
      epoch,
      signal,
      onProgress,
    });
  }

  private receive(
    message: UserMessage | SystemRequestMessage,
    onProgress: (progress: AgentProgress) => void,
  ): { history: readonly ConversationMessage[]; epoch: number } {
    const { editor, conversation, pendingChanges } = this.deps;
    if (pendingChanges.discardAll().length) editor.clearPreview();
    const history = conversation.messages();
    const epoch = conversation.epoch;
    conversation.append(message);
    onProgress({ stage: 'received', message });
    return { history, epoch };
  }

  private async runAgent(
    request: string,
    history: readonly ConversationMessage[],
    initialTranscript: readonly AgentTurn[],
    run: RequestRun,
  ): Promise<AgentResult> {
    const { agent, conversation } = this.deps;
    const { epoch, signal, onProgress } = run;
    const workspace = await this.readWorkspace(signal);
    conversation.ensureCurrent(epoch);
    const transcript: AgentTurn[] = [...initialTranscript];
    for (let step = 1; ; step += 1) {
      onProgress({ stage: 'thinking', step });
      const { decision, contextUsage } = await agent.decide({
        message: request,
        conversation: history,
        workspace,
        transcript: [...transcript],
        signal,
      });
      conversation.ensureCurrent(epoch);
      let accepted: AcceptedDecision;
      try {
        accepted = acceptDecision(decision, workspace, transcript);
      } catch (error) {
        if (!isAgentMistake(error)) throw error;
        transcript.push({ kind: 'mistake', decision, problem: error.message });
        if (!hasMistakesLeft(transcript)) throw new AgentMistakeLimitError(error);
        continue;
      }
      if (accepted.kind !== 'tool') {
        return await this.answer(accepted, contextUsage, run);
      }
      const result = await this.tools.run(accepted.run, onProgress, signal);
      conversation.ensureCurrent(epoch);
      transcript.push({ kind: 'tool', call: accepted.call, result });
    }
  }

  private async readWorkspace(signal: CancellationSignal): Promise<AgentWorkspace> {
    const { project, editor } = this.deps;
    const files = project.listFiles();
    const shown = project.shownFile();
    await project.openFile(shown, signal);
    return {
      files,
      openFile: { path: shown.path, document: editor.readDocument(shown) },
      cursorLine: editor.readCursorLine(shown),
      selection: editor.readSelection(shown),
    };
  }

  private async answer(
    reply: Exclude<AcceptedDecision, { readonly kind: 'tool' }>,
    contextUsage: ContextUsage,
    { epoch, signal, onProgress }: RequestRun,
  ): Promise<AgentResult> {
    switch (reply.kind) {
      case 'answer':
        return { kind: 'reply', message: this.reply('explanation', reply.text), contextUsage };
      case 'question':
        return { kind: 'reply', message: this.reply('clarification', reply.text), contextUsage };
      case 'edit': {
        await showProjectFile(this.deps.project, reply.change.file, onProgress, signal);
        this.deps.conversation.ensureCurrent(epoch);
        const message = this.propose(reply.change);
        return { kind: 'proposal', message, changeId: message.id, contextUsage };
      }
    }
  }

  private propose(edit: ProjectEdit): ProposalMessage {
    const change = new PendingDocumentChange(this.deps.newId(), edit);
    this.deps.pendingChanges.add(change);
    this.showPreview(change);
    const message: ProposalMessage = {
      id: change.id,
      role: 'assistant',
      kind: 'proposal',
      path: edit.file.path,
      command: edit.edit.command,
    };
    this.deps.conversation.append(message);
    return message;
  }

  private showPreview(change: PendingDocumentChange): void {
    const { editor } = this.deps;
    const { file, edit } = change.change;
    try {
      edit.assertCurrent(editor.readDocument(file));
      editor.showPreview(file, edit);
    } catch (error) {
      change.discard();
      editor.clearPreview();
      throw error;
    }
    change.markPreviewed();
  }

  private greet(): GreetingMessage {
    const message: GreetingMessage = { id: this.deps.newId(), role: 'assistant', kind: 'greeting' };
    this.deps.conversation.append(message);
    return message;
  }

  private reply(kind: ReplyMessage['kind'], text: string): ReplyMessage {
    const message: ReplyMessage = { id: this.deps.newId(), role: 'assistant', kind, text };
    this.deps.conversation.append(message);
    return message;
  }
}
