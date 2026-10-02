import { describe, expect, it } from "vitest";
import { evaluate, CalcError } from "@/lib/tools/calculator";
import { runJavaScript } from "@/lib/tools/code-execution";

describe("calculator", () => {
  it.each([
    ["1+2*3", 7],
    ["(1+2)*3", 9],
    ["2^3^2", 512],
    ["-2^2", -4],
    ["10/4", 2.5],
    ["10 % 3", 1],
    ["50%", 0.5],
    ["200*15%", 30],
    ["5!", 120],
    ["sqrt(16)+abs(-3)", 7],
    ["max(1, 7, 3)", 7],
    ["round(pi*100)/100", 3.14],
    ["1,000,000 / 4", 250000],
    ["3 × 4 ÷ 2", 6],
    ["1e3+1", 1001],
  ])("%s = %d", (expr, want) => expect(evaluate(expr)).toBeCloseTo(want, 10));

  it("rejects code injection and bad input", () => {
    for (const bad of ["process.exit()", "constructor", "1/0", "2+", "(1+2", "foo(1)", "a".repeat(501)]) {
      expect(() => evaluate(bad)).toThrow(CalcError);
    }
  });
});

describe("code execution sandbox", () => {
  it("runs code and captures output", async () => {
    const r = await runJavaScript("console.log('hi'); [1,2,3].map(x => x*2)");
    expect(r.ok).toBe(true);
    expect(r.logs).toEqual(["hi"]);
    expect(r.result).toBe("[2,4,6]");
  });
  it("has no access to require/process", async () => {
    const r1 = await runJavaScript("typeof require + ',' + typeof process + ',' + typeof fetch");
    expect(r1.result).toBe("undefined,undefined,undefined");
    const r2 = await runJavaScript("eval('1+1')");
    expect(r2.ok).toBe(false);
  });
  it("kills infinite loops", async () => {
    const r = await runJavaScript("while(true){}", 300);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/i);
  }, 5000);
});
