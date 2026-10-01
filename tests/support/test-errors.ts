import { NamedError } from '../../src/domain/errors';

export class UnexpectedFakeCallError extends NamedError {}

export class TestFixtureError extends NamedError {}
