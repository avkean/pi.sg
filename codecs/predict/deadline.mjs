export class PredictionDeadlineError extends Error {
  constructor() {
    super('Prediction time budget');
    this.name = 'PredictionDeadlineError';
    this.code = 'DEADLINE';
  }
}

export function checkPredictionDeadline(deadline) {
  if (performance.now() > deadline) throw new PredictionDeadlineError();
}

export function isPredictionDeadline(error) {
  return error instanceof PredictionDeadlineError || error?.code === 'DEADLINE';
}
