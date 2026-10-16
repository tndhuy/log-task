export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function flag(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  if (index === -1) {
    if (required) throw new UsageError(`${name} is required`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return value;
}
