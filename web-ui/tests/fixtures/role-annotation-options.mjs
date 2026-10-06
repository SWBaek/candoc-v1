import { fileURLToPath } from 'node:url';
import { runAnnotationSuggestions } from '../../server/role-annotations.mjs';
import { runCodexSuggestions } from '../../server/codex-suggestions.mjs';
export function annotationOptions(mode = 'success') {
  const launch = { executable: process.execPath, args: [fileURLToPath(new URL('./fake-role-annotation-app-server.mjs', import.meta.url)), mode] };
  return { roleAnnotationRunner: args => runAnnotationSuggestions({ ...args, launch, timeoutMs: 5000 }), roleModelRunner: args => runCodexSuggestions({ ...args, catalogue: true, launch }) };
}
