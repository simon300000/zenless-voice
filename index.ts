import { join } from 'path'

import { checkResultFolder, unpackPCKs } from './hoyo-voice-extractor/index.js'

const PCK_SOURCE = process.env.VOICE_SOURCE_PATH || join(import.meta.dirname, 'StreamingAssets', 'Audio', 'Windows', 'Full')
const RESULT = process.env.VOICE_RESULT_PATH || join(import.meta.dirname, 'result')

await checkResultFolder(RESULT)
await unpackPCKs(PCK_SOURCE, join(RESULT, 'wem'), join(RESULT, 'wav'))
