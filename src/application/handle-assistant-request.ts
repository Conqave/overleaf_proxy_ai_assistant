import { Evidence, Intent, type AssistantPlan } from '../domain/assistant-plan';
import {
  summarizeProposal,
  type AssistantMessage,
  type ProposalMessage,
  type ReplyMessage,
  type UserMessage,
} from '../domain/conversation';
import type { DocumentSnapshot } from '../domain/document';
import { InvariantViolation } from '../domain/errors';
import type { ResolvedEdit } from '../domain/resolved-edit';
import type { AssistantPort, GatheredEvidence } from '../ports/assistant-port';
import type { EditorPort } from '../ports/editor-port';
import type { ConversationLog } from './conversation-log';
import { EmptyRequestError, RequestInProgressError, RequestSupersededError } from './errors';
import { GREETING_REPLY, isGreetingOnly } from './greeting-policy';
import { PendingDocumentChange, type PendingChanges } from './pending-change';

export type RequestProgress =
  | { readonly stage: 'received'; readonly message: UserMessage }
  | { readonly stage: 'planning' }
  | { readonly stage: 'answering'; readonly plan: AssistantPlan };

export interface AssistantRequestResult {
  readonly message: AssistantMessage;
  readonly changeId?: string;
}

interface EditorContext {
  readonly document: DocumentSnapshot;
  readonly cursorLine: number;
  readonly selection: string;
  readonly compileLogs: string;
}

const LINE_CONTEXT_RADIUS = 2;

const ANSWER_KIND = {
  summary: 'summary',
  explain: 'explanation',
} as const;

export class HandleAssistantRequest {
  private running = false;

  constructor(
    private readonly deps: {
      assistant: AssistantPort;
      editor: EditorPort;
      conversation: ConversationLog;
      pendingChanges: PendingChanges;
      newId: () => string;
    },
  ) {}

  async execute(
    text: string,
    onProgress: (progress: RequestProgress) => void,
  ): Promise<AssistantRequestResult> {
    if (this.running) throw new RequestInProgressError();
    this.running = true;
    try {
      return await this.run(text, onProgress);
    } finally {
      this.running = false;
    }
  }

  private async run(
    text: string,
    onProgress: (progress: RequestProgress) => void,
  ): Promise<AssistantRequestResult> {
    const { assistant, editor, conversation, pendingChanges } = this.deps;
    const request = text.trim();
    if (!request) throw new EmptyRequestError();

    if (pendingChanges.discardAll().length) editor.clearPreview();
    const history = conversation.messages();
    const epoch = conversation.epoch;
    const userMessage: UserMessage = { id: this.deps.newId(), role: 'user', text: request };
    conversation.append(userMessage);
    onProgress({ stage: 'received', message: userMessage });

    if (isGreetingOnly(request)) {
      return { message: this.reply('greeting', GREETING_REPLY) };
    }

    const context = this.readEditorContext();

    onProgress({ stage: 'planning' });
    const plan = await assistant.plan({ message: request, conversation: history });
    this.ensureCurrent(epoch);

    onProgress({ stage: 'answering', plan });
    const reply = await assistant.reply({
      message: request,
      plan,
      evidence: gatherEvidence(plan, context),
      conversation: history,
    });
    this.ensureCurrent(epoch);

    switch (reply.kind) {
      case 'answer':
        if (plan.intent === Intent.Edit) {
          throw new InvariantViolation('assistant port answered an edit plan with plain text');
        }
        return { message: this.reply(ANSWER_KIND[plan.intent], reply.text) };
      case 'question':
        return { message: this.reply('clarification', reply.text) };
      case 'edit':
        if (plan.intent !== Intent.Edit) {
          throw new InvariantViolation('assistant port returned an edit for a non-edit plan');
        }
        return this.propose(reply.edit, reply.plan);
    }
  }

  private readEditorContext(): EditorContext {
    const { editor } = this.deps;
    return {
      document: editor.readDocument(),
      cursorLine: editor.readCursorLine(),
      selection: editor.readSelection(),
      compileLogs: editor.readCompileLogs(),
    };
  }

  private ensureCurrent(epoch: number): void {
    if (this.deps.conversation.epoch !== epoch) throw new RequestSupersededError();
  }

  private propose(edit: ResolvedEdit, plan: string): AssistantRequestResult {
    const change = new PendingDocumentChange(this.deps.newId(), edit, this.deps.newId());
    this.deps.pendingChanges.add(change);
    this.showPreview(change);
    const { command } = edit;
    const message: ProposalMessage = {
      id: change.messageId,
      role: 'assistant',
      kind: 'proposal',
      text: [command.reason, 'content' in command ? command.content : '']
        .filter(Boolean)
        .join('\n\n'),
      plan,
      proposal: summarizeProposal(command),
    };
    this.deps.conversation.append(message);
    return { message, changeId: change.id };
  }

  private showPreview(change: PendingDocumentChange): void {
    const { editor } = this.deps;
    try {
      change.edit.assertCurrent(editor.readDocument());
      editor.showPreview(change.edit);
    } catch (error) {
      change.discard();
      editor.clearPreview();
      throw error;
    }
    change.markPreviewed();
  }

  private reply(kind: ReplyMessage['kind'], text: string): ReplyMessage {
    const message: ReplyMessage = { id: this.deps.newId(), role: 'assistant', kind, text };
    this.deps.conversation.append(message);
    return message;
  }
}

function gatherEvidence(plan: AssistantPlan, context: EditorContext): GatheredEvidence {
  const needs = new Set(plan.needs);
  const { document, cursorLine } = context;
  const firstLineNumber = Math.max(1, cursorLine - LINE_CONTEXT_RADIUS);
  return {
    document,
    ...(needs.has(Evidence.LineContext)
      ? {
          lineContext: {
            firstLineNumber,
            lines: document.lines.slice(firstLineNumber - 1, cursorLine + LINE_CONTEXT_RADIUS),
          },
        }
      : {}),
    ...(needs.has(Evidence.Selection) && context.selection ? { selection: context.selection } : {}),
    ...(needs.has(Evidence.Logs) && context.compileLogs ? { logs: context.compileLogs } : {}),
  };
}
