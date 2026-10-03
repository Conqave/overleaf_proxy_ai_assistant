import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestSupersededError } from '../../../src/application/errors';
import { answer, tool } from '../../support/decisions';
import { SUBAGENT_POLICY } from '../../../src/domain/agent-policy';
import { MAX_DELEGATION_RESULT_CHARS } from '../../../src/domain/delegation';
import { MAIN_AGENT_POLICY } from '../../support/policies';
import { AssistantProtocolError, AssistantUnreachableError } from '../../../src/ports/errors';
import { EMPTY_CONVERSATION, PendingStep, rejectOnAbort } from '../../support/fakes';
import { itemAt } from '../../support/guards';
import { TestFixtureError } from '../../support/test-errors';
import { UseCaseWorld, bibEdit, readBib } from '../../support/use-case-world';

let world: UseCaseWorld;

beforeEach(() => {
  world = new UseCaseWorld();
});

describe('delegation to a subagent', () => {
  const TASK = 'Check that every \\cite key of the project is defined in refs.bib';
  const delegate = (files: readonly string[] = []) => tool({ tool: 'delegate', task: TASK, files });
  const delegationOf = (index: number) => {
    const message = itemAt(
      world.conversation.messages().filter((m) => m.role === 'tool'),
      index,
      'tool message',
    );
    if (message.record.tool !== 'delegate') {
      throw new TestFixtureError(`tool message ${String(index)} is no delegation`);
    }
    return message.record;
  };

  it('runs the subtask in a fresh context and gives the main agent only its findings', async () => {
    world.agent.will(
      delegate(['main.tex']),
      tool({ tool: 'search', query: '\\cite{' }),
      readBib(),
      answer('main.tex:4 \\cite{knuth84}: key missing from refs.bib'),
      answer('knuth84 is not defined in refs.bib.'),
    );
    const result = await world.send('are all citations defined?');
    expect(result.message).toMatchObject({ text: 'knuth84 is not defined in refs.bib.' });
    const subtask = world.requestAt(1);
    expect(subtask.request).toEqual({ kind: 'subtask', task: TASK, files: ['main.tex'] });
    expect(subtask.conversation).toEqual(EMPTY_CONVERSATION);
    expect(subtask.transcript).toEqual([]);
    expect(world.requestAt(3).transcript.map((turn) => turn.kind)).toEqual(['tool', 'tool']);
    const main = world.requestAt(4);
    expect(main.request).toMatchObject({ kind: 'user' });
    expect(main.transcript).toEqual([
      {
        kind: 'tool',
        call: { tool: 'delegate', task: TASK, files: ['main.tex'] },
        result: {
          tool: 'delegate',
          report: {
            outcome: 'finished',
            text: 'main.tex:4 \\cite{knuth84}: key missing from refs.bib',
            truncated: false,
            lookups: 2,
          },
        },
      },
    ]);
    expect(world.storedMessages().map((m) => m.role)).toEqual(['user', 'tool', 'assistant']);
    expect(delegationOf(0)).toMatchObject({ task: TASK, files: ['main.tex'] });
  });

  it('reports the subagent as reviewing the named files, or else every text file', async () => {
    world.agent.will(
      delegate(['refs.bib', 'chapters']),
      tool({ tool: 'search', query: 'knuth', path: 'chapters' }),
      readBib(),
      answer('Nothing.'),
      answer('Done.'),
    );
    await world.send('check');
    const reviewing = world.progress.flatMap((p) =>
      p.stage === 'delegating' ? [p.fileCount] : [],
    );
    expect(reviewing).toEqual([2]);
    const steps = world.progress.flatMap((p) => (p.stage === 'subagent' ? [p.progress.stage] : []));
    expect(steps).toEqual([
      'thinking',
      'measured',
      'searching',
      'thinking',
      'measured',
      'reading',
      'thinking',
      'measured',
    ]);
    world.progress = [];
    world.agent.will(delegate(), answer('All defined.'), answer('Done.'));
    await world.send('check all');
    expect(world.progress.filter((p) => p.stage === 'delegating')).toEqual([
      { stage: 'delegating', task: TASK, fileCount: 3 },
    ]);
  });

  it('counts the text files of a folder the delegation names once', async () => {
    world.agent.will(
      delegate(['chapters', 'chapters/intro.tex', 'main.tex']),
      tool({ tool: 'search', query: 'knuth' }),
      answer('Ok.'),
      answer('Done.'),
    );
    await world.send('check');
    expect(world.progress.filter((p) => p.stage === 'delegating')).toEqual([
      { stage: 'delegating', task: TASK, fileCount: 2 },
    ]);
    expect(world.requestAt(1).request).toEqual({
      kind: 'subtask',
      task: TASK,
      files: ['chapters/intro.tex', 'main.tex'],
    });
  });

  it('rejects findings until every file of the task is checked', async () => {
    world.agent.will(
      delegate(['main.tex', 'chapters']),
      answer('Too early.'),
      tool({ tool: 'search', query: 'knuth', path: 'main.tex' }),
      answer('Still early.'),
      tool({ tool: 'read_file', path: 'chapters/intro.tex' }),
      answer('All checked.'),
      answer('Done.'),
    );
    await world.send('check');
    const subtask = (index: number) =>
      itemAt(
        world.agent.requests.filter((r) => r.request.kind === 'subtask'),
        index,
        'subtask step',
      );
    expect(subtask(1).transcript).toEqual([
      {
        kind: 'mistake',
        decision: answer('Too early.'),
        problem:
          'main.tex, chapters/intro.tex of the task are not checked yet; read_file or search each of them before you reply',
      },
    ]);
    expect(subtask(3).transcript.at(-1)).toEqual({
      kind: 'mistake',
      decision: answer('Still early.'),
      problem:
        'chapters/intro.tex of the task is not checked yet; read_file or search each of them before you reply',
    });
    expect(delegationOf(0).report).toMatchObject({ text: 'All checked.', lookups: 2 });
  });

  it('records the delegation like any other lookup and reports it once', async () => {
    world.agent.will(delegate(), answer('All defined.'), answer('Done.'));
    await world.send('check');
    const recorded = world.progress.flatMap((p) => (p.stage === 'recorded' ? [p.message] : []));
    expect(recorded).toEqual([world.conversation.messages().find((m) => m.role === 'tool')]);
    expect(recorded).toHaveLength(1);
  });

  it('keeps the lookups of the subagent out of the conversation', async () => {
    world.agent.will(delegate(), readBib(), answer('All defined.'), answer('Done.'));
    await world.send('check');
    expect(world.conversation.messages().filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(world.project.reads).toEqual(['refs.bib']);
  });

  it('lets the subagent search only the file or folder it names', async () => {
    world.agent.will(
      delegate(),
      tool({ tool: 'search', query: 'knuth', path: 'chapters' }),
      tool({ tool: 'search', query: 'knuth', path: 'appendix' }),
      answer('Only the intro mentions knuth.'),
      answer('Done.'),
    );
    await world.send('where is knuth mentioned in the chapters?');
    expect(world.project.reads).toEqual(['chapters/intro.tex']);
    expect(world.requestAt(3).transcript).toEqual([
      {
        kind: 'tool',
        call: { tool: 'search', query: 'knuth', path: 'chapters' },
        result: {
          tool: 'search',
          matches: [{ path: 'chapters/intro.tex', lineNumber: 1, lineText: 'Intro about knuth.' }],
          truncated: false,
        },
      },
      {
        kind: 'mistake',
        decision: tool({ tool: 'search', query: 'knuth', path: 'appendix' }),
        problem: 'The project has no file or folder appendix.',
      },
    ]);
  });

  it('forbids the subagent to delegate further and lets it correct itself', async () => {
    world.agent.will(delegate(), delegate(), answer('All defined.'), answer('Done.'));
    await world.send('check');
    expect(world.requestAt(2).transcript).toEqual([
      {
        kind: 'mistake',
        decision: delegate(),
        problem: 'delegate is not available in this task; use only read_file or search',
      },
    ]);
    expect(delegationOf(0).report).toMatchObject({ outcome: 'finished', text: 'All defined.' });
  });

  it('forbids the subagent to edit or ask', async () => {
    world.agent.will(delegate(), bibEdit(), answer('All defined.'), answer('Done.'));
    await world.send('check');
    expect(world.requestAt(2).transcript).toMatchObject([
      { kind: 'mistake', problem: 'edit is not available in this task; reply with answer' },
    ]);
    expect(world.editor.preview).toBeNull();
  });

  it('turns repeated mistakes of the subagent into a failed delegation the main agent sees', async () => {
    const limit = SUBAGENT_POLICY.maxConsecutiveMistakes;
    world.agent.will(delegate(), ...Array.from({ length: limit }, () => tool({ tool: 'compile' })));
    world.agent.will(answer('The check failed.'));
    const result = await world.send('check');
    expect(result.message).toMatchObject({ text: 'The check failed.' });
    expect(world.project.compileCalls).toBe(0);
    expect(delegationOf(0).report).toEqual({
      outcome: 'failed',
      problem: `the subagent stopped after ${String(limit)} invalid steps in a row (last: compile is not available in this task; use only read_file or search)`,
      lookups: 0,
    });
  });

  it('stops the subagent at its own step limit', async () => {
    const lookups = SUBAGENT_POLICY.maxToolCalls;
    const limit = SUBAGENT_POLICY.maxConsecutiveMistakes;
    world.agent.will(
      delegate(),
      ...Array.from({ length: lookups + limit }, (_, index) =>
        tool({ tool: 'search', query: `key${String(index)}` }),
      ),
      answer('Too much to check.'),
    );
    await world.send('check');
    const subtaskSteps = world.agent.requests.filter((r) => r.request.kind === 'subtask');
    expect(subtaskSteps).toHaveLength(lookups + limit);
    expect(delegationOf(0).report).toEqual({
      outcome: 'failed',
      problem: `the subagent stopped after ${String(limit)} invalid steps in a row (last: all ${String(lookups)} lookups are used; reply now with answer)`,
      lookups,
    });
  });

  it('turns a subagent reply in a broken format into a failed delegation', async () => {
    world.agent.will(delegate(), new AssistantProtocolError('format'), answer('No result.'));
    await world.send('check');
    expect(delegationOf(0).report).toMatchObject({
      outcome: 'failed',
      problem: 'the subagent stopped: format',
    });
  });

  it('lets other failures of the subagent end the whole request', async () => {
    world.agent.will(delegate(), new AssistantUnreachableError('offline'));
    await expect(world.send('check')).rejects.toThrow(AssistantUnreachableError);
    expect(world.conversation.messages().map((m) => m.role)).toEqual(['user', 'notice']);
  });

  it('cuts the findings of the subagent at the policy limit', async () => {
    const long = 'x'.repeat(MAX_DELEGATION_RESULT_CHARS + 10);
    world.agent.will(delegate(), answer(long), answer('Done.'));
    await world.send('check');
    expect(delegationOf(0).report).toEqual({
      outcome: 'finished',
      text: long.slice(0, MAX_DELEGATION_RESULT_CHARS),
      truncated: true,
      lookups: 0,
    });
  });

  it('cancels the subagent with the request', async () => {
    world.agent.will(delegate(), new PendingStep(rejectOnAbort));
    const running = world.send('check');
    await vi.waitFor(() => {
      expect(world.agent.requests).toHaveLength(2);
    });
    const reset = world.startNew();
    await expect(running).rejects.toThrow(RequestSupersededError);
    await reset;
    expect(world.isBusy()).toBe(false);
    expect(itemAt(world.agent.requests, 1, 'subtask').signal.aborted).toBe(true);
  });

  it('rejects a delegation that names a file the project does not have', async () => {
    world.agent.will(delegate(['appendix.tex']), answer('There is no appendix.tex.'));
    await world.send('check');
    expect(world.requestAt(1).transcript).toEqual([
      {
        kind: 'mistake',
        decision: delegate(['appendix.tex']),
        problem: 'The project has no file or folder appendix.tex.',
      },
    ]);
    expect(world.requestAt(1).request.kind).toBe('user');
  });

  it('limits the delegations of one request', async () => {
    const other = (index: number) =>
      tool({ tool: 'delegate', task: `Find the tables of chapter ${String(index)}`, files: [] });
    world.agent.will(other(1), answer('One.'), other(2), answer('Two.'), other(3), answer('Done.'));
    await world.send('check');
    expect(itemAt(world.agent.requests, 5, 'main step').transcript.at(-1)).toEqual({
      kind: 'mistake',
      decision: other(3),
      problem: `all ${String(MAIN_AGENT_POLICY.maxDelegations)} delegations of this request are used; do the remaining lookups yourself or reply`,
    });
  });
});
