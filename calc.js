// Safe arithmetic evaluator for the keypad (no eval).
// Supports + − × ÷, decimals, and iPhone-style %: "200+10%" = 220, "50%" = 0.5.

const OPS = { '+': 1, '−': 1, '×': 2, '÷': 2 };

export function tokenize(expr) {
  const tokens = [];
  let num = '';
  for (const ch of expr) {
    if (/[0-9.]/.test(ch)) {
      num += ch;
      continue;
    }
    if (num) tokens.push(num), (num = '');
    if (ch in OPS || ch === '%') tokens.push(ch);
  }
  if (num) tokens.push(num);
  return tokens;
}

export function evaluate(expr) {
  let tokens = tokenize(expr);
  // Ignore a dangling operator so "12+" shows 12 while typing.
  while (tokens.length && tokens[tokens.length - 1] in OPS) tokens.pop();
  if (!tokens.length) return 0;

  const values = [];
  const ops = [];
  const apply = () => {
    const op = ops.pop();
    const b = values.pop();
    const a = values.pop();
    values.push(op === '+' ? a + b : op === '−' ? a - b : op === '×' ? a * b : b === 0 ? NaN : a / b);
  };

  for (const t of tokens) {
    if (t === '%') {
      const v = values.pop();
      const lastOp = ops[ops.length - 1];
      // "a + b%" means b percent of a; otherwise just b/100.
      values.push((lastOp === '+' || lastOp === '−') && values.length ? (values[values.length - 1] * v) / 100 : v / 100);
    } else if (t in OPS) {
      while (ops.length && OPS[ops[ops.length - 1]] >= OPS[t]) apply();
      ops.push(t);
    } else {
      values.push(parseFloat(t) || 0);
    }
  }
  while (ops.length) apply();
  return values[0];
}
