import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureProject = path.resolve(process.env.CANDOC_FIXTURE_PROJECT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../working-project/ieee-1547'));
export const fixtureJson = path.join(fixtureProject, 'raw/ieee1547-document.json');
