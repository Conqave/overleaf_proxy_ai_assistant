import type { AssistantPlan } from '../../domain/assistant-plan';
import type { AssistantReply } from '../../domain/assistant-reply';
import type { AssistantPort, PlanningRequest, ReplyRequest } from '../../ports/assistant-port';
import { AssistantProtocolError } from '../../ports/errors';
import {
  createCorrectionRequest,
  createPlanExchange,
  createReplyExchange,
  getPromptBudget,
  type ProtocolExchange,
} from './assistant-protocol';
import { InvalidAssistantResponse } from './assistant-response-parser';
import type { OllamaClient } from './ollama-client';

export class OllamaAssistant implements AssistantPort {
  private readonly promptBudget: number;

  constructor(
    private readonly client: OllamaClient,
    contextTokens: number,
  ) {
    this.promptBudget = getPromptBudget(contextTokens);
  }

  plan(request: PlanningRequest): Promise<AssistantPlan> {
    return this.exchange(createPlanExchange(request, this.promptBudget));
  }

  reply(request: ReplyRequest): Promise<AssistantReply> {
    return this.exchange(createReplyExchange(request, this.promptBudget));
  }

  private async exchange<T>(exchange: ProtocolExchange<T>): Promise<T> {
    const first = await this.client.generate(exchange.request);
    try {
      return exchange.parse(first);
    } catch (error) {
      if (!(error instanceof InvalidAssistantResponse)) throw error;
      const second = await this.client.generate(
        createCorrectionRequest(exchange, first, error.problem),
      );
      try {
        return exchange.parse(second);
      } catch (retryError) {
        if (!(retryError instanceof InvalidAssistantResponse)) throw retryError;
        throw new AssistantProtocolError(
          `The assistant replied in an unexpected format (${retryError.problem}). Please try again.`,
          { cause: retryError },
        );
      }
    }
  }
}
