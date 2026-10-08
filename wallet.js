// The whole wallet: keys, addresses, authorizations and the delegatee API.
// No PSBT is ever built here: delegatee builds every transaction, the
// contract only accepts the ones this key authorized.
import { secp256k1, schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { bech32, bech32m, hex } from '@scure/base'

const utf8 = (s) => new TextEncoder().encode(s)
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const le = (n, size) => {
  const out = new Uint8Array(size)
  let v = BigInt(n)
  for (let i = 0; i < size; i++, v >>= 8n) out[i] = Number(v & 0xffn)
  return out
}
const be64 = (n) => le(n, 8).reverse()
const toBig = (b) => BigInt('0x' + (hex.encode(b) || '0'))

// minimal script number, what the contract reads as an int
export function scriptNum(n) {
  let v = BigInt(n)
  if (v === 0n) return new Uint8Array()
  const neg = v < 0n
  if (neg) v = -v
  const out = []
  for (; v > 0n; v >>= 8n) out.push(Number(v & 0xffn))
  if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0)
  else if (neg) out[out.length - 1] |= 0x80
  return Uint8Array.from(out)
}

const pushData = (b) => concat([b.length], b)
const pushNum = (n) => (n === 0 ? Uint8Array.of(0) : n <= 16 ? Uint8Array.of(0x50 + n) : pushData(scriptNum(n)))
const compactSize = (n) => (n < 0xfd ? Uint8Array.of(n) : concat([0xfd], le(n, 2)))

// BIP68 relative locktime as arkd counts it: seconds from 512 on, blocks below
export const sequence = (delay) => (delay >= 512 ? (1 << 22) | Math.floor(delay / 512) : delay)

// ---- taproot, as btcd assembles it ----

const UNSPENDABLE = hex.decode('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0')
const tagged = schnorr.utils.taggedHash

export const leafHash = (script) => tagged('TapLeaf', Uint8Array.of(0xc0), compactSize(script.length), script)

function branch(a, b) {
  const [x, y] = hex.encode(a) < hex.encode(b) ? [a, b] : [b, a]
  return tagged('TapBranch', x, y)
}

// pairs leaves in order, folds an odd last leaf into the last pair, then pairs branches as a queue
export function treeRoot(hashes) {
  if (hashes.length === 1) return hashes[0]
  const branches = []
  for (let i = 0; i < hashes.length; i += 2) {
    if (i === hashes.length - 1) branches[branches.length - 1] = branch(branches[branches.length - 1], hashes[i])
    else branches.push(branch(hashes[i], hashes[i + 1]))
  }
  while (branches.length > 1) branches.push(branch(branches.shift(), branches.shift()))
  return branches[0]
}

export function taprootKey(root) {
  const internal = schnorr.utils.lift_x(toBig(UNSPENDABLE))
  const t = toBig(tagged('TapTweak', UNSPENDABLE, root)) % secp256k1.CURVE.n
  return internal.add(secp256k1.ProjectivePoint.BASE.multiply(t)).toRawBytes(true).slice(1)
}

const p2tr = (key) => concat([0x51, 0x20], key)

// ---- addresses ----

const arkHrp = (network) => (network === 'bitcoin' ? 'ark' : 'tark')
const btcHrp = (network) => ({ bitcoin: 'bc', regtest: 'bcrt' })[network] ?? 'tb'

export const arkAddress = (network, server, key) =>
  bech32m.encode(arkHrp(network), bech32m.toWords(concat([0], server, key)), 1023)

export const onchainAddress = (network, key) => bech32m.encode(btcHrp(network), [1, ...bech32m.toWords(key)])

// destination returns the script an address pays, and whether it is offchain
export function destination(address, network, server) {
  const lower = address.trim().toLowerCase()
  if (lower.startsWith(arkHrp(network) + '1')) {
    const data = bech32m.fromWords(bech32m.decode(lower, 1023).words)
    if (data.length !== 65 || data[0] !== 0) throw new Error('unknown ark address version')
    if (!equal(data.slice(1, 33), server)) throw new Error('the address belongs to another ark server')
    return { offchain: true, script: p2tr(data.slice(33)) }
  }
  if (!lower.startsWith(btcHrp(network) + '1')) throw new Error(`not a ${network} address`)
  const coder = lower[btcHrp(network).length + 1] === 'q' ? bech32 : bech32m
  const { words } = coder.decode(lower)
  const version = words[0]
  const program = coder.fromWords(words.slice(1))
  if (version > 16 || program.length < 2 || program.length > 40) throw new Error('bad segwit address')
  return { offchain: false, script: concat([version ? 0x50 + version : 0, program.length], program) }
}

// ---- keys and contract ----

export function newSecret() {
  return hex.encode(secp256k1.utils.randomPrivateKey())
}

export function keysOf(secret) {
  const priv = hex.decode(secret)
  const owner = secp256k1.getPublicKey(priv, true)
  return { priv, owner, xonly: owner.slice(1) }
}

export const exitLeaf = (xonly, delay) => concat(pushNum(sequence(delay)), [0xb2, 0x75, 0x20], xonly, [0xac])

// 2-of-2 with the ark server: <a> CHECKSIGVERIFY <b> CHECKSIG, the server being a or b
const withServer = (leaf, server, owner) =>
  leaf.length === 68 && leaf[0] === 0x20 && leaf[33] === 0xad && leaf[34] === 0x20 && leaf[67] === 0xac &&
  (equal(leaf.slice(1, 33), server) || (equal(leaf.slice(1, 33), owner) && equal(leaf.slice(35, 67), server)))

// checkWatch makes sure the tree delegatee derived holds our exit leaf, every other leaf being a 2-of-2 with the server
export function checkWatch(tapscripts, key, exit, server, owner) {
  const leaves = tapscripts.map((s) => hex.decode(s))
  if (!equal(taprootKey(treeRoot(leaves.map(leafHash))), key)) throw new Error('tapscripts do not match the address')
  if (!leaves.some((l) => equal(l, exit))) throw new Error('the address has no exit leaf for this key')
  if (!leaves.every((l) => equal(l, exit) || withServer(l, server, owner))) throw new Error('a leaf can spend without the ark server')
}

// ---- authorizations ----

const TAGS = { send: 'simplestwallet/send/v1', withdraw: 'simplestwallet/withdraw/v1' }

// authMessage is what each input's CSFS checks; prevTxid is in internal byte order
export function authMessage(kind, prevTxid, vout, amount, change, validUntil, destScript) {
  const version = destScript[0] === 0 ? 0 : destScript[0] - 0x50
  const program = destScript.slice(2)
  return sha256(
    concat(
      utf8(TAGS[kind]), prevTxid, le(vout, 4), le(amount, 8), le(change, 8), le(validUntil, 8),
      sha256(concat([version], program)),
    ),
  )
}

const internalTxid = (txid) => hex.decode(txid).reverse()

// checkpointTxid is the virtual tx arkd puts between a vtxo and the ark tx spending it through leaf
export function checkpointTxid(vtxo, leaf, unrollScript) {
  const script = p2tr(taprootKey(branch(leafHash(unrollScript), leafHash(leaf))))
  const tx = concat(
    le(3, 4),
    [1],
    internalTxid(vtxo.txid),
    le(vtxo.vout, 4),
    [0],
    le(0xffffffff, 4),
    [2],
    le(vtxo.amount, 8),
    pushData(script),
    le(0, 8),
    hex.decode('0451024e73'),
    le(0, 4),
  )
  return sha256(sha256(tx))
}

// spendTemplate spends n coins: amount to dest, the rest back to the wallet when change > 0
export function spendTemplate(kind, n, change, artifact) {
  const inputs = Array.from({ length: n }, (_, i) => `in${i}`)
  const variables = {
    owner: 'pubkey', exit_delay: 'int', renewal_window: 'int', max_fee: 'int',
    amount: 'int', change: 'int', valid_until: 'int', dest: 'bytes',
  }
  inputs.forEach((_, i) => (variables[`sig_${i}`] = 'bytes'))
  const doc = {
    format: 'delegateed-template/v1',
    type: kind === 'send' ? 'offchain' : 'intent',
    variables,
    inputs: inputs.map((name, i) => ({
      name,
      contract: {
        definition: { artifact },
        arguments: { owner: '<owner>', exitDelay: '<exit_delay>', renewalWindow: '<renewal_window>', maxFee: '<max_fee>' },
      },
      spend: { function: kind, leaf: kind, arguments: ['<valid_until>', '<amount>', '<change>', `<sig_${i}>`] },
    })),
  }
  const payment = (index, fixed) => ({
    name: 'payment',
    ...(kind === 'withdraw' && { type: 'onchain' }),
    index,
    value: { from: inputs, ...(fixed && { amount: '<amount>' }) },
    locking: '<dest>',
  })
  const back = { name: 'change', index: 0, value: { from: inputs }, locking: { from: 'in0' } }
  if (kind === 'send') {
    doc.outputs = change > 0 ? [back, payment(1, true)] : [payment(0, false)]
    doc.packets = { output_index: doc.outputs.length }
  } else {
    variables.fee_max = 'int'
    doc.outputs = change > 0 ? [back, payment(2, true)] : [payment(1, false)]
    doc.packets = { output_index: change > 0 ? 1 : 0 }
    doc.fees = { from: 'in0', max: '<fee_max>' }
  }
  return doc
}

// fingerprint is delegatee's spend id: sha256(template || 0 || variables JSON, keys sorted || 0 || outpoints)
export function fingerprint(templateId, variables, outpoints) {
  const sorted = Object.fromEntries(Object.entries(variables).sort(([a], [b]) => (a < b ? -1 : 1)))
  return sha256(concat(utf8(templateId), [0], utf8(JSON.stringify(sorted)), [0], utf8(outpoints.join(','))))
}

// ---- the wallet ----

const call = async (url, path, body) => {
  const res = await fetch(url + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.message || `${path}: HTTP ${res.status}`)
  return json
}

const vtxoOf = (v) => {
  const [txid, vout] = v.outpoint.split(':')
  return { outpoint: v.outpoint, txid, vout: Number(vout), amount: Number(v.amount), expiresAt: Number(v.expiresAt || 0) }
}

export class Wallet {
  // docs: { artifact, renewal, boarding } parsed from contract/; config: see config.json
  constructor(secret, config, docs) {
    Object.assign(this, keysOf(secret))
    this.config = config
    this.docs = docs
  }

  async init() {
    const { config } = this
    const ark = await call(config.arkUrl, '/v1/info')
    this.network = ark.network
    this.server = hex.decode(ark.signerPubkey).slice(1)
    this.unroll = hex.decode(ark.checkpointTapscript)
    this.dust = Number(ark.dust)
    const artifact = (await call(config.delegateeUrl, '/v1/artifact', { document: JSON.stringify(this.docs.artifact) })).artifact.id
    this.artifact = artifact
    const register = async (doc) =>
      (await call(config.delegateeUrl, '/v1/template', { document: JSON.stringify(doc).replace('SIMPLE_WALLET', artifact) })).template.id
    this.variables = {
      owner: hex.encode(this.owner),
      exit_delay: hex.encode(scriptNum(sequence(Number(ark.unilateralExitDelay)))),
      renewal_window: hex.encode(scriptNum(config.renewalWindow)),
      max_fee: hex.encode(scriptNum(config.maxFee)),
    }
    const watch = async (templateId, variables) =>
      (await call(config.delegateeUrl, '/v1/delegate', { templateId, variables, expiresAt: 0 })).delegation

    const funds = await watch(await register(this.docs.renewal), this.variables)
    const key = bech32m.fromWords(bech32m.decode(funds.address, 1023).words).slice(33)
    checkWatch(funds.slots[0].tapscripts, key, exitLeaf(this.xonly, Number(ark.unilateralExitDelay)), this.server, this.xonly)
    this.address = funds.address
    this.leaves = funds.slots[0].tapscripts // exit, renew, send, withdraw

    const boarding = await watch(await register(this.docs.boarding), {
      ...this.variables,
      boarding_exit_delay: hex.encode(scriptNum(sequence(Number(ark.boardingExitDelay)))),
    })
    const program = bech32m.fromWords(bech32m.decode(boarding.address).words.slice(1))
    checkWatch(boarding.slots[0].tapscripts, program, exitLeaf(this.xonly, Number(ark.boardingExitDelay)), this.server, this.xonly)
    this.boardingAddress = boarding.address
    return this
  }

  async coins() {
    const get = (a) => call(this.config.delegateeUrl, `/v1/delegate/${a}`)
    const [funds, boarding] = await Promise.all([get(this.address), get(this.boardingAddress)])
    return {
      vtxos: (funds.vtxos || []).map(vtxoOf).filter((v) => v.amount > 0),
      deposits: (boarding.vtxos || []).map(vtxoOf),
    }
  }

  async balance() {
    const { vtxos, deposits } = await this.coins()
    const sum = (l) => l.reduce((n, v) => n + v.amount, 0)
    return { available: sum(vtxos), boarding: sum(deposits) }
  }

  // spendable leaves out coins about to renew: they would be gone before the spend runs
  spendable(vtxos) {
    const soon = Date.now() / 1000 + this.config.renewalWindow + 30
    return vtxos.filter((v) => !v.expiresAt || v.expiresAt > soon)
  }

  // send pays amount sats to an ark address (offchain) or a bitcoin address (collaborative exit)
  async send(address, amount) {
    const dest = destination(address, this.network, this.server)
    const kind = dest.offchain ? 'send' : 'withdraw'
    const feeMax = dest.offchain ? 0 : this.config.withdrawFeeMax
    const vtxos = this.spendable((await this.coins()).vtxos)
    vtxos.sort((a, b) => b.amount - a.amount)
    const picked = []
    let total = 0
    for (const v of vtxos) {
      if (total >= amount + feeMax) break
      picked.push(v)
      total += v.amount
    }
    if (total < amount + feeMax) throw new Error(`not enough funds: ${total} sats, need ${amount + feeMax}`)
    let change = total - amount - feeMax
    if (change < this.dust) {
      amount = total - feeMax
      change = 0
    }
    if (amount < this.dust) throw new Error(`amount below dust (${this.dust})`)

    const doc = spendTemplate(kind, picked.length, change, this.artifact)
    const templateId = (await call(this.config.delegateeUrl, '/v1/template', { document: JSON.stringify(doc) })).template.id
    const variables = {
      ...this.variables,
      amount: hex.encode(scriptNum(amount)),
      change: hex.encode(scriptNum(change)),
      dest: hex.encode(dest.script),
      ...(kind === 'withdraw' && { fee_max: hex.encode(scriptNum(feeMax)) }),
    }
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.spendLifetime
    variables.valid_until = hex.encode(scriptNum(expiresAt))
    const leaf = hex.decode(this.leaves[2])
    picked.forEach((v, i) => {
      const [prevTxid, vout] = kind === 'send' ? [checkpointTxid(v, leaf, this.unroll), 0] : [internalTxid(v.txid), v.vout]
      const msg = authMessage(kind, prevTxid, vout, amount, change, expiresAt, dest.script)
      variables[`sig_${i}`] = hex.encode(schnorr.sign(msg, this.priv))
    })
    const outpoints = picked.map((v) => v.outpoint)
    const id = fingerprint(templateId, variables, outpoints)
    const signature = schnorr.sign(tagged('delegatee/spend', id, be64(expiresAt)), this.priv)
    const res = await call(this.config.delegateeUrl, '/v1/spend', {
      templateId, variables, outpoints, expiresAt,
      pubkey: hex.encode(this.xonly), signature: hex.encode(signature),
    })
    return { id: res.id, amount, change, kind }
  }

  // status is active (in flight), done (coins spent), expired or cancelled; sent says delegatee spent them itself
  async spendStatus(id) {
    const res = await call(this.config.delegateeUrl, `/v1/spend/${id}`)
    const attempts = res.renewals || []
    const failed = attempts.filter((r) => !r.success)
    return { status: res.delegation.status, sent: attempts.some((r) => r.success), error: failed.length ? failed[0].error : '' }
  }
}
