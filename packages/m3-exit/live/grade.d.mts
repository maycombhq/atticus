export interface ExitResult {
  run: string;
  pass: boolean;
  reason: string;
  details: Record<string, unknown>;
}
export interface GradedExit {
  name: string;
  passed: number;
  total: number;
  required: number;
  verdict: "PASS" | "FAIL";
  provisional: boolean;
  results: ExitResult[];
}
export interface Grades {
  generatedAt: string;
  outDir: string;
  runs: string[];
  exits: {
    a: GradedExit;
    b: GradedExit;
    c: GradedExit;
    d: GradedExit;
    e: {
      name: string;
      verdict: "FOR A PERSON";
      file: string;
      results: { run: string; complete: boolean; reason: string }[];
    };
  };
}
export const EXITS: Record<"a" | "b" | "c" | "d" | "e", string>;
export function required(total: number): number;
export function grade(outDir: string): Promise<Grades>;
export function report(result: Grades): string[];
