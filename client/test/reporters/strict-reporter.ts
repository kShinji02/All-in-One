import type { Reporter, TestModule } from 'vitest/node';

/**
 * Reprova a execução se algum teste foi ignorado (`skip`), marcado como
 * pendente (`todo`) ou não chegou a rodar. Junto com `allowOnly: false` e
 * `passWithNoTests: false`, garante que "verde" significa "tudo executado".
 */
export default class StrictReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const offenders: string[] = [];
    let total = 0;

    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        total += 1;
        const { state } = testCase.result();
        const { mode } = testCase.options;
        if (state === 'skipped' || state === 'pending' || mode === 'skip' || mode === 'todo') {
          offenders.push(`  - ${testCase.fullName} [mode=${mode}, state=${state}]`);
        }
      }
    }

    if (offenders.length > 0) {
      console.error(
        `\n[strict-reporter] ${offenders.length} de ${total} teste(s) não foram executados:\n${offenders.join('\n')}\n`,
      );
      process.exitCode = 1;
    } else {
      console.log(`[strict-reporter] ${total} teste(s) executados, nenhum ignorado ou pendente.`);
    }
  }
}
