import { createCipheriv } from 'crypto'
import { gunzipSync } from 'zlib'

import { decompress as decompressOodle } from 'ooz-wasm'
import xxhash from 'xxhash-wasm'

const { h64: xxHash64 } = await xxhash()

const MHY_SHIFT_ROW = Buffer.from('0b02080c0105000f060709030d040e0a0405070a020f0b080e0d09060c03000108000c06040b070905030f010d0a020e', 'hex')
const MHY_KEY = Buffer.from('481436ed8e445bb6', 'hex')
const MHY_MUL = Buffer.from('a7996650b92df078', 'hex')
const MHY_SBOX = Buffer.from(
  'f7e7d8b86431d17488aab48b6aa3fc5559c56dc99a112f37ad35156261044401dd473dff8f51af0f1923921300534b67211c1b94e2299f4cfbbb75f0fe1fdbef1df13a1a0506cede630a6b2d28416c0c42dc58b6392ed2f62bac849617f33f8dab95cd300e6690f4ede08ec2782c7ef85d0291fa3cdab76ff94f145eea24569ec1a585d708834ef57632865cd3095ffd3603eee334777918bddf9771ba65687a548048385b4d5a7f0b7ca67b25d60d40d007999d9369d98cb3b5a41ecb3382e9c360a7ae45beb146b29c22c78198a9d56ee110cabc4a70d4c47212cf2a8716c873a13e5250a85727eccc7de4a089bfe58a20ebc0a249b9e826c6e6b03b9bf2435eb0e60df987d78adfe719996fd55b4ecbc248d2f2443503e986d095024a0462c59d1de2fd53088d5d75d93f9459142998768c792e8f390c4cc8c0819c10bbaff7e5b2b3ee5657b8fa407a7277246cc6473a74cf89b49b26aa3809c31cde9fdd161f55bdadac804f644b71b7f6062bc701ea46a6eb3dca07341bff7c7d2d3767609ac4977fd6beae85258865a200b68ed46e1a633692c1e115a5583b7e222f840f5c96b1f16d8bf4a8b50bfe23e3cef8f5514543181ed1babc90217030c92aec617b665f1333206bcd3ca09331b90582fb3e17126a0acc4da1735278bf285069dc6842e0a42ceff011e89149835af332dbabda270eeda3fc41a7a9d39ee4d85495aef0d57324d2a5990b1bc49ad8696f25ed8e9163f835625b9488b25c0fdda47a1a12c63744f14eb94d43d1adebb44680305ee4876e0a82cf7438b5c1d60105e883a96dcea8c551a33fda03d03a396c11976854c04bdf190c211f66bde96149c842bcec7fc34f2ea1583d81e314b802239e772b33a69313340e0645fb07750d1e40ab7df5bb55ef0465792fcaf329cbea17f4e6714c5026d9785f099c1c8531229bc9e08fac578b7c477e16f7085a591dc7f9002d603c9f96a2ba2070f648b02c72e164e7ffb756a75384d7e2d4a0b18ce52adc15285d3b367b866adb10be6bfe9d18de76f2cdb632fc41afbf67b3aac28afd89ccfa90988d52d3ee923e4a272ad79e025363eae98f35227ffeca75465794d94ed2d476a1c3d8bc9b84879151b1ab816447af9d6a5b2dd6957703c110ad610cbf11347e0138204bb64a1a45995f26bbc5cd23f1f7b48ee1f8685629d53def1228c42e79a648857314e4c66b92302793130de2c9f065dffbe3062f8c4c1815d3493e0759b088a9c83b86ee5c7a5eff8dac08e66054a07d4033a8fce03798bdec09b271581fde7489365266a23c965d509041f5172b0bdcf60083dd6db53a9cb8707c4369fd321bed0f5597c2fa394f9a8219e7786ecba4be24b3f3cccf1cf944a51e803fd021a3e83105168aba670ee5b7d1421ddb726ca7ce044ddac78b9f6f0a2cebf25a7baa25c062aef4b9',
  'hex'
)
const RC4_STATE = Buffer.from(
  '2923be84e16cd6ae529049f1f1bbe9ebb3a6db3c870c3e99245e0d1c06b747deb3124dc843bb8ba61f035a7d0938251f5dd4cbfc96f5453b130d890a1cdbae32209a50ee407836fd124932f69e7d49dcad4f14f2444066d06bc430b7323ba122f622919de18b1fdab0ca9902b9729d492c807ec599d5e980b2eac9cc53bf67d6bf14d67e2ddc8e6683ef574961ff698f61cdd11e9d9c167272e61df0844f4a7702d7e8392c53cbc9121e33749e0cf4d5d49fd4a4597e35cf3222f4cccfd3902d48d38f75e6d91d2ae5c0f72b788187440e5f5000d4618dbe7b0515073b33821f187092da6454ceb1853e6915f8466a0496730ed9162f6768d4f74a4ad0576876',
  'hex'
)

export { xxHash64 }

export const galGamePerformAssetPaths = (value: unknown) => {
  const paths = new Set<string>()
  const visit = (entry: unknown): void => {
    if (typeof entry === 'string' && /^Data\/ScriptConfig\/Perform\/Data\/GalGame\/.+\.asset$/i.test(entry)) {
      paths.add(`assets/napresources/${entry}`.toLowerCase())
    } else if (Array.isArray(entry)) {
      entry.forEach(visit)
    } else if (entry && typeof entry === 'object') {
      Object.values(entry).forEach(visit)
    }
  }
  visit(value)
  return [...paths].sort()
}

export const isGzip = (data: Uint8Array) => data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b

export const galGameBlockNamesFromCatalog = (compressedCatalog: Uint8Array, assetPaths: readonly string[]) => {
  if (!isGzip(compressedCatalog)) throw new Error('resource catalog block is not gzip')
  const catalog = gunzipSync(compressedCatalog)
  if (catalog.length < 52) throw new Error('resource catalog is truncated')
  const assetCount = catalog.readUInt32LE(8)
  const blockCount = catalog.readUInt32LE(12)
  const bundleCount = catalog.readUInt32LE(16)
  const assetsStart = catalog.readUInt32LE(20)
  const blocksStart = Number(catalog.readBigUInt64LE(28))
  const bundlesStart = Number(catalog.readBigUInt64LE(36))
  const bundlesEnd = Number(catalog.readBigUInt64LE(44))
  if (assetsStart !== 52 || blocksStart !== assetsStart + assetCount * 12 || bundlesStart !== blocksStart + blockCount * 9 || bundlesEnd !== bundlesStart + bundleCount * 28 || bundlesEnd > catalog.length) {
    throw new Error('unsupported resource catalog layout')
  }

  const wanted = new Set(assetPaths.map(path => xxHash64(path)))
  const bundleIndexes = new Set<number>()
  for (let index = 0, offset = assetsStart; index < assetCount; index++, offset += 12) {
    if (wanted.has(catalog.readBigUInt64LE(offset + 4))) bundleIndexes.add(catalog.readUInt32LE(offset))
  }

  const blocks = new Set<string>()
  for (const bundleIndex of bundleIndexes) {
    if (bundleIndex >= bundleCount) continue
    const blockIndex = catalog.readUInt32LE(bundlesStart + bundleIndex * 28)
    if (blockIndex >= blockCount) continue
    blocks.add(`Blocks/${catalog.readUInt32LE(blocksStart + blockIndex * 9 + 1)}.blk`)
  }
  return { blocks: [...blocks].sort(), matchedAssets: bundleIndexes.size, totalAssets: assetPaths.length }
}

const gfMultiply = (left: number, right: number) => {
  let a = left
  let b = right
  let result = 0
  while (b) {
    if (b & 1) result ^= a
    a = a & 0x80 ? (a << 1 ^ 0x11b) : a << 1
    b >>= 1
  }
  return result & 0xff
}

const descrambleChunk = (data: Uint8Array) => {
  const vector = new Uint8Array(data.length)
  for (let round = 0; round < 3; round++) {
    for (let index = 0; index < data.length; index++) {
      const source = MHY_SHIFT_ROW[(2 - round) * 16 + index] % data.length
      const keyIndex = index % 8
      vector[index] = MHY_KEY[keyIndex] ^ MHY_SBOX[(index % 4 * 0x100) | gfMultiply(MHY_MUL[keyIndex], data[source])]
    }
    data.set(vector)
  }
}

const rc4 = (data: Uint8Array, key: Uint8Array, operation: Uint8Array) => {
  const state = Uint8Array.from(RC4_STATE)
  const repeatedKey = Uint8Array.from({ length: 256 }, (_, index) => key[index % key.length])
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + repeatedKey[i]) & 0xff
    ;[state[i], state[j]] = [state[j], state[i]]
  }
  let i = 0
  j = 0
  for (let index = 0; index < data.length; index++) {
    i = (i + 1) & 0xff
    j = (j + state[i]) & 0xff
    ;[state[i], state[j]] = [state[j], state[i]]
    const value = state[(state[j] + state[i]) & 0xff]
    switch (operation[i % operation.length] % 3) {
      case 0: data[index] ^= value; break
      case 1: data[index] = data[index] - value & 0xff; break
      case 2: data[index] = data[index] + value & 0xff; break
    }
  }
}

const descramble = (data: Uint8Array, entrySize: number) => {
  const blockSize = Math.min(data.length, 128)
  const roundedEntrySize = Math.ceil(entrySize / 16) * 16
  descrambleChunk(data.subarray(4, 20))
  if (Buffer.from(data.subarray(4, 12)).toString() !== 'mhynewec') throw new Error('invalid mhy1 encrypted signature')
  if (blockSize <= 35) return
  descrambleChunk(data.subarray(20, 36))
  const seed = Buffer.from(data.subarray(0, 16))
  const cipher = createCipheriv('aes-128-ecb', seed, null)
  cipher.setAutoPadding(false)
  const encrypted = cipher.update(data.subarray(20, 36))
  data.set(encrypted, 20)
  for (let index = 0; index < 4; index++) data[index] ^= encrypted[index]
  rc4(data.subarray(20 + roundedEntrySize, blockSize), data.subarray(20, 28), data.subarray(28, 36))
}

class MhyReader {
  offset = 0
  constructor(readonly data: Uint8Array) {}
  bytes(length: number) {
    if (this.offset + length > this.data.length) throw new Error('truncated mhy1 metadata')
    const value = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }
  int() {
    const value = this.bytes(6)
    return value[2] | value[4] << 8 | value[0] << 16 | value[5] << 24
  }
  uint() {
    const value = this.bytes(7)
    return (value[1] | value[6] << 8 | value[3] << 16 | value[2] << 24) >>> 0
  }
  string() {
    const value = this.bytes(0x105)
    const end = value.indexOf(0)
    return Buffer.from(value.subarray(0, end < 0 ? value.length : end)).toString()
  }
}

type MhyNode = { path: string, offset: number, size: number }

const unpackMhyFile = (file: Buffer, start: number) => {
  if (file.toString('ascii', start, start + 4) !== 'mhy1') throw new Error(`invalid mhy1 signature at ${start}`)
  const infoSize = file.readUInt32LE(start + 4)
  const encryptedInfo = Uint8Array.from(file.subarray(start + 8, start + 8 + infoSize))
  descramble(encryptedInfo, 28)
  const info = new MhyReader(encryptedInfo.subarray(48))
  const rawInfoSize = info.uint()
  const compressedInfo = info.bytes(info.data.length - info.offset)
  if (compressedInfo[0] !== 0x8c) throw new Error('mhy1 metadata is not Oodle-compressed')
  const rawInfo = new MhyReader(decompressOodle(compressedInfo, rawInfoSize))
  const nodes: MhyNode[] = []
  const nodeCount = rawInfo.int()
  for (let index = 0; index < nodeCount; index++) {
    const path = rawInfo.string()
    rawInfo.bytes(1)
    nodes.push({ path, offset: rawInfo.int(), size: rawInfo.uint() })
  }
  const blockCount = rawInfo.int()
  const blocks = Array.from({ length: blockCount }, () => ({ compressed: rawInfo.int(), raw: rawInfo.uint() }))
  const rawSize = blocks.reduce((sum, block) => sum + block.raw, 0)
  const contents = Buffer.allocUnsafe(rawSize)
  let sourceOffset = start + 8 + infoSize
  let targetOffset = 0
  for (const block of blocks) {
    const encrypted = Uint8Array.from(file.subarray(sourceOffset, sourceOffset + block.compressed))
    descramble(encrypted, 8)
    const raw = decompressOodle(encrypted.subarray(28), block.raw)
    contents.set(raw, targetOffset)
    sourceOffset += block.compressed
    targetOffset += block.raw
  }
  return {
    files: nodes.filter(node => !node.path.endsWith('.resS')).map(node => contents.subarray(node.offset, node.offset + node.size)),
    end: sourceOffset
  }
}

const utf16AsciiStrings = (data: Uint8Array) => {
  const values: string[] = []
  for (let offset = 0; offset + 7 < data.length;) {
    const start = offset
    while (offset + 1 < data.length && data[offset] >= 0x20 && data[offset] <= 0x7e && data[offset + 1] === 0) offset += 2
    if (offset - start >= 8) values.push(Buffer.from(data.subarray(start, offset)).toString('utf16le'))
    offset = offset === start ? offset + 1 : offset
  }
  return values
}

const SOURCE = /^(?:VO_Galgame\/(?:[A-Za-z0-9_.-]+\/)*VO_[A-Za-z0-9]+\/)?GalGame_[A-Za-z0-9_-]+$/i
const STRICT_SOURCE = /^GalGame_[A-Za-z0-9_-]+$/
const STRICT_TEXT_ID = /^[A-Za-z0-9_]+_GalGame_[A-Za-z0-9_-]+_\d+_\d+$/
const DIALOGUE_KEY = /^[A-Za-z0-9_-]+$/

export const galGameLinksFromBlocks = (blocks: readonly Buffer[]) => {
  const strictSourceToText = new Map<string, Set<string>>()
  const fallbackSourceToText = new Map<string, Set<string>>()
  const sourceNames = new Map<string, string>()
  const addSourceText = (index: Map<string, Set<string>>, source: string, textId: string) => {
    const key = source.toLowerCase()
    const ids = index.get(key) ?? new Set<string>()
    ids.add(textId)
    index.set(key, ids)
    if (!sourceNames.has(key)) sourceNames.set(key, source)
  }
  let mhyFiles = 0
  let cabFiles = 0
  let directPairs = 0
  for (const block of blocks) {
    let offset = 0
    while (offset + 8 <= block.length) {
      while (offset < block.length && block[offset] === 0) offset++
      if (offset + 8 > block.length) break
      const unpacked = unpackMhyFile(block, offset)
      mhyFiles++
      for (const cab of unpacked.files) {
        cabFiles++
        const values = utf16AsciiStrings(cab)
        for (let index = 0; index + 1 < values.length; index++) {
          if (values[index] !== 'dialogueKey' || !DIALOGUE_KEY.test(values[index + 1])) continue
          const textId = values[index + 1]
          for (let cursor = index + 2; cursor < Math.min(index + 12, values.length - 1); cursor++) {
            if (values[cursor] === 'dialogueKey') break
            if (values[cursor] !== 'externalVoiceKey' && values[cursor] !== 'voiceKey') continue
            const source = values[cursor + 1]
            if (!SOURCE.test(source)) continue
            const strict = STRICT_SOURCE.test(source) && STRICT_TEXT_ID.test(textId)
            addSourceText(strict ? strictSourceToText : fallbackSourceToText, source, textId)
            directPairs++
            break
          }
        }
      }
      offset = unpacked.end
    }
  }
  const links = new Map<string, string>()
  let ambiguous = 0
  let fallbackLinks = 0
  const sources = new Set([...strictSourceToText.keys(), ...fallbackSourceToText.keys()])
  for (const source of sources) {
    const strict = strictSourceToText.get(source)
    const fallback = fallbackSourceToText.get(source)
    if (strict?.size === 1) {
      links.set(source, [...strict][0])
    } else if (strict) {
      ambiguous++
    } else if (fallback?.size === 1) {
      links.set(source, [...fallback][0])
      fallbackLinks++
    } else {
      ambiguous++
    }
  }
  return { links, sourceNames, mhyFiles, cabFiles, directPairs, ambiguous, fallbackLinks }
}
