import type { CompileDiagnostic } from '../../domain/agent-transcript';
import { NamedError } from '../../domain/errors';
import type { CancellationSignal } from '../../ports/cancellation';
import {
  CompileTimeoutError,
  CompileWithoutResultError,
  EditsNotSavedError,
} from '../../ports/errors';
import { pause, throwAbortReason, withDeadline } from '../deadline';
import { formatDuration } from '../duration';
import { readCompileDiagnostics } from './compile-log';
import { StoreKey, type OverleafStore } from './overleaf-store';

const RECOMPILE_EVENT = 'pdf:recompile';
const RECOMPILE_BUTTON_SELECTOR = '.toolbar-pdf-left .split-menu-button[data-ol-loading]';
const LOADING_ATTRIBUTE = 'data-ol-loading';
const SAVE_POLL_MS = 25;

export interface OverleafCompileTimeouts {
  readonly saveMs: number;
  readonly compileMs: number;
  readonly compileLogMs: number;
}

interface CompileOutput {
  readonly log: unknown;
  readonly pdf: unknown;
}

export class OverleafToolbarContractError extends NamedError {
  constructor(problem: string) {
    super(`Overleaf's PDF toolbar does not match the expected contract: ${problem}.`);
  }
}

export class OverleafCompiler {
  constructor(
    private readonly window: Window & typeof globalThis,
    private readonly store: OverleafStore,
    private readonly timeouts: OverleafCompileTimeouts,
  ) {}

  async compile(cancel: CancellationSignal): Promise<readonly CompileDiagnostic[]> {
    await withDeadline(
      this.timeouts.saveMs,
      () =>
        new EditsNotSavedError(
          `Overleaf did not save the latest edits within ${formatDuration(this.timeouts.saveMs)}; check the connection and try again.`,
        ),
      [cancel],
      (signal) => this.whenEditsSaved(signal),
    );
    return await withDeadline(
      this.timeouts.compileMs,
      () =>
        new CompileTimeoutError(
          `The project did not compile within ${formatDuration(this.timeouts.compileMs)}.`,
        ),
      [cancel],
      (signal) => this.recompile(signal),
    );
  }

  private async whenEditsSaved(signal: AbortSignal): Promise<void> {
    const document = this.store.getSharedDocument();
    if (document === null) return;
    document.flush();
    while (document.hasBufferedOps()) await pause(SAVE_POLL_MS, signal);
  }

  private async recompile(signal: AbortSignal): Promise<readonly CompileDiagnostic[]> {
    const button = this.recompileButton();
    if (!(await this.whenButton(button, isIdle, signal))) throwAbortReason(signal);
    const before = this.readOutput();
    const finished = this.whenButton(button, hasFinished, signal);
    this.window.dispatchEvent(new this.window.CustomEvent(RECOMPILE_EVENT));
    if (!(await finished)) throwAbortReason(signal);
    return readCompileDiagnostics(await this.nextLog(button, before, signal));
  }

  private nextLog(
    button: HTMLElement,
    before: CompileOutput,
    cancel: AbortSignal,
  ): Promise<unknown> {
    const { store } = this;
    const isNew = (): boolean => {
      const { log, pdf } = this.readOutput();
      return isIdle([], button) && pdf !== before.pdf && log !== null && log !== before.log;
    };
    return withDeadline(
      this.timeouts.compileLogMs,
      () => this.withoutResult(),
      [cancel],
      async (signal) => {
        const published = await store.waitUntil(
          [StoreKey.LogEntries, StoreKey.PdfUrl],
          isNew,
          signal,
        );
        if (!published) throwAbortReason(signal);
        return store.get(StoreKey.LogEntries);
      },
    );
  }

  private readOutput(): CompileOutput {
    return { log: this.store.get(StoreKey.LogEntries), pdf: this.store.get(StoreKey.PdfUrl) };
  }

  private whenButton(
    button: HTMLElement,
    isReached: (records: readonly MutationRecord[], button: HTMLElement) => boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    const reached = Promise.withResolvers<boolean>();
    const observer = new this.window.MutationObserver((records) => {
      if (isReached(records, button)) reached.resolve(true);
    });
    const abort = (): void => {
      reached.resolve(false);
    };
    observer.observe(button, { attributeFilter: [LOADING_ATTRIBUTE], attributeOldValue: true });
    signal.addEventListener('abort', abort);
    if (isReached([], button)) reached.resolve(true);
    if (signal.aborted) abort();
    return reached.promise.finally(() => {
      observer.disconnect();
      signal.removeEventListener('abort', abort);
    });
  }

  private recompileButton(): HTMLElement {
    const button = this.window.document.querySelector<HTMLElement>(RECOMPILE_BUTTON_SELECTOR);
    if (button === null) throw new OverleafToolbarContractError('it has no Recompile button');
    return button;
  }

  private withoutResult(): CompileWithoutResultError {
    return new CompileWithoutResultError(
      'Overleaf finished the compile without a new PDF or log; see the PDF pane for the reason and try again.',
    );
  }
}

function isIdle(_records: readonly MutationRecord[], button: HTMLElement): boolean {
  return !readLoading(button.getAttribute(LOADING_ATTRIBUTE));
}

function hasFinished(records: readonly MutationRecord[]): boolean {
  return records.some((record) => readLoading(record.oldValue));
}

function readLoading(value: string | null): boolean {
  if (value !== 'true' && value !== 'false') {
    throw new OverleafToolbarContractError(
      `the Recompile button has ${LOADING_ATTRIBUTE}=${String(value)}`,
    );
  }
  return value === 'true';
}
