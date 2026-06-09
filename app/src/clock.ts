export interface Clock {
  now(): string; // ISO 8601
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};
