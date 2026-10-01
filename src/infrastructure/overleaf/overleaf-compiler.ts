import { DiagnosticLevel, type CompileDiagnostic } from '../../domain/agent-transcript';
import { NamedError } from '../../domain/errors';
import type { CancellationSignal } from '../../ports/cancellation';
import {
  CompileTimeoutError,
  CompileWithoutResultError,
  EditsNotSavedError,
  UnexplainedCompileFailureError,
} from '../../ports/errors';
import { pause, throwAbortReason, withDeadline } from '../deadline';
import { formatDuration } from '../duration';
import { readCompileDiagnostics } from './compile-log';
import { OverleafStoreContractError, StoreKey, type OverleafStore } from './overleaf-store';

const RECOMPILE_EVENT = 'pdf:recompile';
const RECOMPILE_BUTTON_SELECTOR = '.toolbar-pdf-left .split-menu-button[data-ol-loading]';
const LOADING_ATTRIBUTE = 'data-ol-loading';
const SAVE_POLL_MS = 25;
const SAVE_MS = 20_000;
const COMPILE_MS = 240_000;
const COMPILE_LOG_MS = 15_000;

export class OverleafToolbarContractError extends NamedError {
  constructor(problem: string) {
    super(`Overleaf's PDF toolbar does not match the expected contract: ${problem}.`);
  }
}

export class OverleafCompiler {
  constructor(
    private readonly window: Window & typeof globalThis,
    private readonly store: OverleafStore,
  ) {}

  async compile(cancel: CancellationSignal): Promise<readonly CompileDiagnostic[]> {
    await withDeadline(
      SAVE_MS,
      () =>
        new EditsNotSavedError(
          `Overleaf did not save the latest edits within ${formatDuration(SAVE_MS)}; check the connection and try again.`,
        ),
      [cancel],
      (signal) => this.whenEditsSaved(signal),
    );
    return await withDeadline(
      COMPILE_MS,
      () =>
        new CompileTimeoutError(
          `The project did not compile within ${formatDuration(COMPILE_MS)}.`,
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
    if (!(await this.whenIdle(button, signal))) throwAbortReason(signal);
    const previousPdf = this.store.get(StoreKey.PdfUrl);
    const diagnostics = readCompileDiagnostics(await this.compileLog(button, signal));
    const hasErrors = diagnostics.some(({ level }) => level === DiagnosticLevel.Error);
    if (!hasErrors && this.store.get(StoreKey.PdfUrl) === previousPdf) {
      throw new UnexplainedCompileFailureError(
        'Overleaf finished the compile without a new PDF and without naming an error; see the PDF pane for the reason.',
      );
    }
    return diagnostics;
  }

  private async compileLog(button: HTMLElement, signal: AbortSignal): Promise<unknown> {
    const published = Promise.withResolvers<unknown>();
    const previousLog = this.store.get(StoreKey.LogEntries);
    let started = false;
    let logDeadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (check: () => void): void => {
      try {
        check();
      } catch (error) {
        if (!isContractError(error)) throw error;
        published.reject(error);
      }
    };
    const observer = new this.window.MutationObserver((records) => {
      settle(() => {
        const finished = hasFinished(records);
        started ||= finished || !isIdle(button);
        if (finished) {
          logDeadline ??= setTimeout(() => {
            published.reject(
              new CompileWithoutResultError(
                'Overleaf finished the compile without a new PDF or log; see the PDF pane for the reason and try again.',
              ),
            );
          }, COMPILE_LOG_MS);
        }
      });
    });
    const takeLog = (): void => {
      settle(() => {
        const log = this.store.get(StoreKey.LogEntries);
        if (started && isIdle(button) && log !== null && log !== previousLog) {
          published.resolve(log);
        }
      });
    };
    const abort = (): void => {
      published.reject(signal.reason);
    };
    observer.observe(button, { attributeFilter: [LOADING_ATTRIBUTE], attributeOldValue: true });
    const unwatch = this.store.watch(StoreKey.LogEntries, takeLog);
    signal.addEventListener('abort', abort);
    try {
      this.window.dispatchEvent(new this.window.CustomEvent(RECOMPILE_EVENT));
      return await published.promise;
    } finally {
      clearTimeout(logDeadline);
      observer.disconnect();
      unwatch();
      signal.removeEventListener('abort', abort);
    }
  }

  private async whenIdle(button: HTMLElement, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (isIdle(button)) return true;
    const idle = Promise.withResolvers<boolean>();
    const observer = new this.window.MutationObserver(() => {
      try {
        if (isIdle(button)) idle.resolve(true);
      } catch (error) {
        if (!(error instanceof OverleafToolbarContractError)) throw error;
        idle.reject(error);
      }
    });
    const abort = (): void => {
      idle.resolve(false);
    };
    observer.observe(button, { attributeFilter: [LOADING_ATTRIBUTE] });
    signal.addEventListener('abort', abort);
    try {
      return await idle.promise;
    } finally {
      observer.disconnect();
      signal.removeEventListener('abort', abort);
    }
  }

  private recompileButton(): HTMLElement {
    const button = this.window.document.querySelector<HTMLElement>(RECOMPILE_BUTTON_SELECTOR);
    if (button === null) throw new OverleafToolbarContractError('it has no Recompile button');
    return button;
  }
}

function isIdle(button: HTMLElement): boolean {
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

function isContractError(
  error: unknown,
): error is OverleafToolbarContractError | OverleafStoreContractError {
  return (
    error instanceof OverleafToolbarContractError || error instanceof OverleafStoreContractError
  );
}
