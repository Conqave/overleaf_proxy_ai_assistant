import type { Notice } from '../domain/conversation';
import { OperationalError } from '../domain/errors';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import { OperationCancelledError } from './errors';

export function note(
  conversation: ConversationLog,
  notice: Notice,
  onProgress: (progress: AgentProgress) => void,
): void {
  onProgress({ stage: 'noted', message: conversation.recordNotice(notice) });
}

export async function recordingFailure<T>(
  conversation: ConversationLog,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isRecordedFailure(error) && conversation.sessionId !== null) {
      conversation.recordNotice({ kind: 'failed', problem: error.message });
    }
    throw error;
  }
}

function isRecordedFailure(error: unknown): error is OperationalError {
  return error instanceof OperationalError && !(error instanceof OperationCancelledError);
}
