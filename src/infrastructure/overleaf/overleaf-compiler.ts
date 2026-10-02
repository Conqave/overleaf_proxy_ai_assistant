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
import type { OverleafProjectFiles } from './overleaf-project-files';
import { StoreKey, type OverleafStore } from './overleaf-store';

const RECOMPILE_EVENT = 'pdf:recompile';
const RECOMPILE_BUTTON_SELECTOR = '.toolbar-pdf-left .split-menu-button[data-ol-loading]';
const LOADING_ATTRIBUTE = 'data-ol-loading';
const SAVE_POLL_MS = 25;
const SAVE_MS = 20_000;
const COMPILE_MS = 240_000;
const COMPILE_LOG_MS = 15_000;
const RECENT_COMPILE_LOCK_MS = 2_000;

export class OverleafToolbarContractError extends NamedError {
  constructor(problem: string) {
    super(`Overleaf's PDF toolbar does not match the expected contract: ${problem}.`);
  }
}

export class OverleafCompiler {
  constructor(
    private readonly window: Window & typeof globalThis,
    private readonly store: OverleafStore,
    private readonly files: OverleafProjectFiles,
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
    const diagnostics = await this.compileOnce(button, signal);
    if (diagnostics !== null) return diagnostics;
    await this.files.deleteBuildOutput(signal);
    await pause(RECENT_COMPILE_LOCK_MS, signal);
    signal.throwIfAborted();
    const rebuilt = await this.compileOnce(button, signal);
    if (rebuilt === null) {
      throw new UnexplainedCompileFailureError(
        'Overleaf finished the compile without a new PDF and without naming an error; see the PDF pane for the reason.',
      );
    }
    return rebuilt;
  }

  private async compileOnce(
    button: HTMLElement,
    signal: AbortSignal,
  ): Promise<readonly CompileDiagnostic[] | null> {
    const previousPdf = this.store.get(StoreKey.PdfUrl);
    const diagnostics = readCompileDiagnostics(await this.compileLog(button, signal));
    const hasErrors = diagnostics.some(({ level }) => level === DiagnosticLevel.Error);
    if (!hasErrors && this.store.get(StoreKey.PdfUrl) === previousPdf) return null;
    return diagnostics;
  }

  private async compileLog(button: HTMLElement, signal: AbortSignal): Promise<unknown> {
    const previousLog = this.store.get(StoreKey.LogEntries);
    const changes = new ChangeSignal();
    const events: CompileEvent[] = [];
    let logDeadline: ReturnType<typeof setTimeout> | undefined;
    const observer = new this.window.MutationObserver((records) => {
      events.push({ kind: 'button', records });
      changes.notify();
    });
    const publishLog = (): void => {
      events.push({ kind: 'log' });
      changes.notify();
    };
    observer.observe(button, { attributeFilter: [LOADING_ATTRIBUTE], attributeOldValue: true });
    const unwatch = this.store.watch(StoreKey.LogEntries, publishLog);
    signal.addEventListener('abort', changes.notify);
    try {
      this.window.dispatchEvent(new this.window.CustomEvent(RECOMPILE_EVENT));
      let started = false;
      let hasNewLog = false;
      for (;;) {
        await changes.next();
        signal.throwIfAborted();
        for (const event of events.splice(0)) {
          switch (event.kind) {
            case 'button': {
              const finished = hasFinished(event.records);
              started ||= finished || !isIdle(button);
              if (finished) {
                logDeadline ??= setTimeout(() => {
                  events.push({ kind: 'log-overdue' });
                  changes.notify();
                }, COMPILE_LOG_MS);
              }
              break;
            }
            case 'log':
              hasNewLog ||= started;
              break;
            case 'log-overdue':
              throw new CompileWithoutResultError(
                'Overleaf finished the compile without a new PDF or log; see the PDF pane for the reason and try again.',
              );
          }
        }
        const log = this.store.get(StoreKey.LogEntries);
        if (hasNewLog && isIdle(button) && log !== null && log !== previousLog) return log;
      }
    } finally {
      clearTimeout(logDeadline);
      observer.disconnect();
      unwatch();
      signal.removeEventListener('abort', changes.notify);
    }
  }

  private async whenIdle(button: HTMLElement, signal: AbortSignal): Promise<boolean> {
    const changes = new ChangeSignal();
    const observer = new this.window.MutationObserver(changes.notify);
    observer.observe(button, { attributeFilter: [LOADING_ATTRIBUTE] });
    signal.addEventListener('abort', changes.notify);
    try {
      for (;;) {
        if (signal.aborted) return false;
        if (isIdle(button)) return true;
        await changes.next();
      }
    } finally {
      observer.disconnect();
      signal.removeEventListener('abort', changes.notify);
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

type CompileEvent =
  | { readonly kind: 'button'; readonly records: readonly MutationRecord[] }
  | { readonly kind: 'log' }
  | { readonly kind: 'log-overdue' };

class ChangeSignal {
  private changed = Promise.withResolvers<undefined>();

  readonly notify = (): void => {
    this.changed.resolve(undefined);
  };

  async next(): Promise<void> {
    await this.changed.promise;
    this.changed = Promise.withResolvers<undefined>();
  }
}
