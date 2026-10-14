export type ArithmeticNode =
  | { kind: 'literal'; value: number }
  | { kind: 'input'; name: string; value: number }
  | {
      kind: 'unary';
      operator: '+' | '-';
      operand: ArithmeticNode;
      value: number;
    }
  | {
      kind: 'binary';
      operator: '+' | '-' | '*' | '/';
      left: ArithmeticNode;
      right: ArithmeticNode;
      value: number;
    };

export interface ArithmeticResult {
  value: number;
  literals: number[];
  names: string[];
  tree: ArithmeticNode;
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
  function primary(depth: number): ArithmeticNode {
    if (depth > 32) throw new Error('depth');
    const token = tokens[position++];
    if (token === '+' || token === '-') {
      const value = primary(depth + 1);
      return {
        kind: 'unary',
        operator: token,
        operand: value,
        value: token === '-' ? -value.value : value.value,
      };
    }
    if (token === '(') {
      const value = sum(depth + 1);
      if (tokens[position++] !== ')') throw new Error('parenthesis');
      return value;
    }
    if (token && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token)) {
      const value = Number(token);
      literals.push(value);
      return { kind: 'literal', value };
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
      return { kind: 'input', name: token, value };
    }
    throw new Error('token');
  }
  function product(depth: number): ArithmeticNode {
    let value = primary(depth);
    while (tokens[position] === '*' || tokens[position] === '/') {
      const operator = tokens[position++];
      const right = primary(depth);
      value = {
        kind: 'binary',
        operator: operator as '*' | '/',
        left: value,
        right,
        value:
          operator === '*'
            ? value.value * right.value
            : value.value / right.value,
      };
    }
    return value;
  }
  function sum(depth: number): ArithmeticNode {
    let value = product(depth);
    while (tokens[position] === '+' || tokens[position] === '-') {
      const operator = tokens[position++];
      const right = product(depth);
      value = {
        kind: 'binary',
        operator: operator as '+' | '-',
        left: value,
        right,
        value:
          operator === '+'
            ? value.value + right.value
            : value.value - right.value,
      };
    }
    return value;
  }
  try {
    const tree = sum(0);
    if (position !== tokens.length || !Number.isFinite(tree.value))
      return undefined;
    return { value: tree.value, literals, names, tree };
  } catch {
    return undefined;
  }
}
