import type { Scenario, ScenarioFigure } from '../model/index.js';
import { evaluateArithmetic, type ArithmeticNode } from './arith.js';
import { normalizeUnit, textNumbers } from './numbers.js';

interface Quantity {
  value: number;
  unit: string;
  bill: boolean;
}

/** Arithmetic retains dimensions; a duration or head count is never a money rate. */
export function computedIsGrounded(
  figure: ScenarioFigure,
  figures: readonly ScenarioFigure[],
  assumptions: Scenario['profile']['assumptions'],
  citedText: string,
): boolean {
  const named = new Map<string, Quantity>(
    assumptions.map((a) => [
      a.key,
      { value: a.value, unit: normalizeUnit(a.unit), bill: false },
    ]),
  );
  figures
    .filter((f) => f.source === 'bill')
    .forEach((f, index) => {
      named.set(`bill_${String(index)}`, {
        value: f.value,
        unit: normalizeUnit(f.unit),
        bill: true,
      });
    });
  const bill = textNumbers(citedText)
    .filter((n) => n.unit)
    .map((n) => ({ ...n, bill: true }));
  const literals = [...named.values(), ...bill];
  const inputs = Object.fromEntries(
    [...named].map(([name, quantity]) => [name, quantity.value]),
  );
  function hasCalculation(node: ArithmeticNode): boolean {
    return (
      node.kind === 'binary' ||
      (node.kind === 'unary' && hasCalculation(node.operand))
    );
  }
  const result = evaluateArithmetic(figure.expr ?? '', inputs);
  if (
    !result ||
    !hasCalculation(result.tree) ||
    Math.abs(result.value - figure.value) >
      1e-9 * Math.max(1, Math.abs(figure.value))
  )
    return false;

  function leaf(node: ArithmeticNode, percent = false): Quantity[] {
    const input = node.kind === 'input' ? named.get(node.name) : undefined;
    const candidates =
      node.kind === 'input'
        ? input
          ? [input]
          : []
        : node.kind === 'literal'
          ? literals.filter((q) => q.value === node.value)
          : [];
    if (percent)
      return candidates.filter((q) => q.bill && q.unit === 'percent');
    return [
      ...candidates.filter((q) => q.unit !== 'percent'),
      ...(node.kind === 'literal'
        ? bill
            .filter((q) => q.unit === 'percent' && q.value / 100 === node.value)
            .map(() => ({ value: node.value, unit: 'ratio', bill: true }))
        : []),
    ];
  }
  function combine(
    operator: '+' | '-' | '*' | '/',
    left: Quantity[],
    right: Quantity[],
  ): Quantity[] {
    const quantities: Quantity[] = [];
    for (const a of left)
      for (const b of right) {
        let unit: string | undefined;
        if (operator === '+' || operator === '-') {
          if (a.unit === b.unit) unit = a.unit;
        } else if (operator === '*') {
          if (a.unit === 'ratio') unit = b.unit;
          else if (b.unit === 'ratio') unit = a.unit;
        } else {
          if (b.unit === 'ratio') unit = a.unit;
          else if (a.unit === b.unit) unit = 'ratio';
        }
        if (unit) quantities.push({ value: 0, unit, bill: a.bill || b.bill });
      }
    // Keep the search bounded even when the same value occurs under many units.
    return [
      ...new Map(
        quantities.map((q) => [`${q.unit}:${String(q.bill)}`, q]),
      ).values(),
    ];
  }
  function convertPercent(node: ArithmeticNode): Quantity[] {
    // In the left-associative income * 4 / 100, only the rightmost factor is converted.
    if (node.kind === 'binary' && node.operator === '*')
      return combine('*', infer(node.left), convertPercent(node.right));
    return leaf(node, true).map(() => ({
      value: 0,
      unit: 'ratio',
      bill: true,
    }));
  }
  function infer(node: ArithmeticNode): Quantity[] {
    if (node.kind === 'unary') return infer(node.operand);
    if (node.kind !== 'binary') return leaf(node);
    if (
      node.operator === '/' &&
      node.right.kind === 'literal' &&
      node.right.value === 100
    ) {
      const converted = convertPercent(node.left);
      if (converted.length) return converted;
    }
    return combine(node.operator, infer(node.left), infer(node.right));
  }
  return infer(result.tree).some(
    (q) => q.bill && q.unit === normalizeUnit(figure.unit),
  );
}
