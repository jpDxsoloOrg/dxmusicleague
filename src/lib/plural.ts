/** "1 round" / "3 rounds": a count with its noun, singular when the count is 1. */
export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}
