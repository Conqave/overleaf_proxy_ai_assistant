export class UnexpectedFakeCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedFakeCallError';
  }
}

export class TestFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestFixtureError';
  }
}
