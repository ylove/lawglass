export interface ArithmeticResult {
  value: number;
  literals: number[];
  names: string[];
}

/** Bounded recursive descent: expressions are data, never executable JavaScript. */
export function evaluateArithmetic(
  expression: string,
  inputs: Readonly<Record<string, number>> = {},
): ArithmeticResult | undefined {
  if (!expression.trim() || expression.length > 512) return undefined;
  const source = expression
    .replaceAll('−', '-')
    .replaceAll('×', '*')
    .replaceAll('÷', '/');
  const tokens =
    source.match(/\d+(?:\.\d+)?|\.\d+|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g) ?? [];
  if (tokens.length > 128) return undefined;
  let position = 0;
  const literals: number[] = [];
  const names: string[] = [];
  function primary(depth: number): number {
    if (depth > 32) throw new Error('depth');
    const token = tokens[position++];
    if (token === '+' || token === '-') {
      const value = primary(depth + 1);
      return token === '-' ? -value : value;
    }
    if (token === '(') {
      const value = sum(depth + 1);
      if (tokens[position++] !== ')') throw new Error('parenthesis');
      return value;
    }
    if (token && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token)) {
      const value = Number(token);
      literals.push(value);
      return value;
    }
    if (
      token &&
      /^[A-Za-z_][A-Za-z_0-9]*$/.test(token) &&
      Object.hasOwn(inputs, token)
    ) {
      const value = inputs[token];
      if (value === undefined || !Number.isFinite(value))
        throw new Error('input');
      names.push(token);
      return value;
    }
    throw new Error('token');
  }
  function product(depth: number): number {
    let value = primary(depth);
    while (tokens[position] === '*' || tokens[position] === '/') {
      const operator = tokens[position++];
      const right = primary(depth);
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  }
  function sum(depth: number): number {
    let value = product(depth);
    while (tokens[position] === '+' || tokens[position] === '-') {
      const operator = tokens[position++];
      const right = product(depth);
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }
  try {
    const value = sum(0);
    if (position !== tokens.length || !Number.isFinite(value)) return undefined;
    return { value, literals, names };
  } catch {
    return undefined;
  }
}
