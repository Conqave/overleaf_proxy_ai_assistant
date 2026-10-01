import type { AssistantPlan } from '../../domain/assistant-plan';
import type { AssistantReply } from '../../domain/assistant-reply';
import type { AssistantPort, PlanningRequest, ReplyRequest } from '../../ports/assistant-port';
import { createPlanExchange, createReplyExchange, getPromptBudget } from './assistant-protocol';
import { runExchange } from './correction-exchange';
import type { OllamaClient } from './ollama-client';

export class OllamaAssistant implements AssistantPort {
  private readonly promptBudget: number;

  constructor(private readonly client: OllamaClient) {
    this.promptBudget = getPromptBudget(client.contextTokens);
  }

  async plan(request: PlanningRequest): Promise<AssistantPlan> {
    return await runExchange(this.client, createPlanExchange(request, this.promptBudget));
  }

  async reply(request: ReplyRequest): Promise<AssistantReply> {
    return await runExchange(this.client, createReplyExchange(request, this.promptBudget));
  }
}
