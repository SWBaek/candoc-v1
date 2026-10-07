import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCodexSuggestions } from '../../server/codex-suggestions.mjs';
export function annotationOptions() {
  const file = path.join(path.dirname(process.argv[2]), 'project-fixture-thread.json');
  return { codexModelRunner: async () => [{ model: 'test-model', displayName: 'Synthetic local fixture', efforts: ['medium'], defaultEffort: 'medium', isDefault: true }],
    projectAgentRunner: args => runCodexSuggestions({ ...args, launch: { executable: process.execPath, args: [fileURLToPath(new URL('./fake-project-agent-app-server.mjs', import.meta.url)), file] }, timeoutMs: 15000 }) };
}
