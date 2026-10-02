/**
 * Safe arithmetic evaluator (no eval / Function). Recursive-descent parser.
 * Supports + - * / % ^, parentheses, unary minus, constants (pi, e), and common functions.
 */
const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp, min: Math.min, max: Math.max, pow: Math.pow,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

export class CalcError extends Error {}

export function evaluate(expr: string): number {
  if (expr.length > 500) throw new CalcError("Expression too long");
  const src = expr.replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/,(?=\d{3}\b)/g, "");
  let i = 0;
  const peek = () => src[i];
  const eat = (c: string) => (src[i] === c ? (i++, true) : false);

  function number(): number {
    const m = src.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
    if (!m) throw new CalcError(`Unexpected '${peek() ?? "end"}' at position ${i}`);
    i += m[0].length;
    return Number(m[0]);
  }
  function primary(): number {
    if (eat("(")) {
      const v = expr_();
      if (!eat(")")) throw new CalcError("Missing )");
      return v;
    }
    const id = src.slice(i).match(/^[a-z][a-z0-9]*/i)?.[0];
    if (id) {
      i += id.length;
      const name = id.toLowerCase();
      if (name in CONSTS) return CONSTS[name];
      const f = FUNCS[name];
      if (!f) throw new CalcError(`Unknown function '${id}'`);
      if (!eat("(")) throw new CalcError(`Expected ( after ${id}`);
      const args = [expr_()];
      while (eat(",")) args.push(expr_());
      if (!eat(")")) throw new CalcError("Missing )");
      return f(...args);
    }
    return number();
  }
  function postfix(): number {
    let v = primary();
    while (peek() === "!" || peek() === "%") {
      if (eat("!")) {
        if (v < 0 || !Number.isInteger(v) || v > 170) throw new CalcError("Factorial needs an integer 0–170");
        let r = 1;
        for (let k = 2; k <= v; k++) r *= k;
        v = r;
      } else if (src[i] === "%" && (i + 1 >= src.length || /[)+\-*/^,]/.test(src[i + 1]))) {
        i++;
        v = v / 100;
      } else break;
    }
    return v;
  }
  function unary(): number {
    if (eat("-")) return -unary();
    if (eat("+")) return unary();
    return power();
  }
  function power(): number {
    const base = postfix();
    if (eat("^")) return Math.pow(base, unary()); // right-associative
    return base;
  }
  function term(): number {
    let v = unary();
    while (true) {
      if (eat("*")) v *= unary();
      else if (eat("/")) {
        const d = unary();
        if (d === 0) throw new CalcError("Division by zero");
        v /= d;
      } else if (peek() === "%" && i + 1 < src.length && !/[)+\-*/^,]/.test(src[i + 1])) {
        i++;
        v %= unary();
      } else return v;
    }
  }
  function expr_(): number {
    let v = term();
    while (true) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  }
  const result = expr_();
  if (i !== src.length) throw new CalcError(`Unexpected '${src[i]}' at position ${i}`);
  if (!Number.isFinite(result)) throw new CalcError("Result is not a finite number");
  return result;
}
