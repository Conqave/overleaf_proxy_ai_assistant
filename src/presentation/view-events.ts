import type { WebSearchDecision } from '../application/web-search-approval';

export interface ViewEvents {
  send(text: string): Promise<void>;
  apply(proposalId: string, index: number | null): Promise<void>;
  reject(proposalId: string, index: number | null): Promise<void>;
  previewFile(proposalId: string, path: string): Promise<void>;
  undo(proposalId: string): Promise<void>;
  newConversation(): Promise<void>;
  showSessions(): Promise<void>;
  openSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  exportSession(id: string): Promise<void>;
  showImports(): Promise<void>;
  importSession(path: string): Promise<void>;
  compact(): Promise<void>;
  decideWebSearch(id: string, decision: WebSearchDecision): Promise<void>;
}
