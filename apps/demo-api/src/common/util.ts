export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Integer in [min, max]. */
export const between = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min + 1))

export const chance = (rate: number) => Math.random() < rate
