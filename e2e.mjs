// End to end on the regtest stack: board, send offchain, exit to chain, send everything, spend several coins.
// Needs nigiri, arkd, the emulator and a delegatee at config.json's urls.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { schnorr } from '@noble/curves/secp256k1'
import { Wallet, newSecret, onchainAddress } from './wallet.js'

const config = read('./config.json')
const docs = { artifact: read('./contract/simple_wallet.json'), renewal: read('./contract/renewal.json'), boarding: read('./contract/boarding.json') }

// a down stack would only show up as a failing spend
for (const url of [`${config.arkUrl}/v1/info`, `${config.delegateeUrl}/v1/info`]) {
  if (!(await fetch(url).then((r) => r.ok, () => false))) throw new Error(`stack is down: ${url}`)
}

const alice = await new Wallet(newSecret(), config, docs).init()
const bob = await new Wallet(newSecret(), config, docs).init()
console.log('alice', alice.address, alice.boardingAddress)
console.log('bob  ', bob.address)

console.log('board 20,000 sats')
execSync(`nigiri faucet ${alice.boardingAddress} 0.0002`)
await until('boarding', async () => (await balance(alice)) >= 20_000)

console.log('alice sends 5,000 to bob offchain')
await settle(alice, await alice.send(bob.address, 5_000))
await until('bob is paid', async () => (await balance(bob)) === 5_000)

console.log('alice exits 3,000 to a bitcoin address')
const onchain = onchainAddress(alice.network, schnorr.getPublicKey(schnorr.utils.randomPrivateKey()))
await settle(alice, await alice.send(onchain, 3_000))
await until('onchain payment', async () => {
  const utxos = await (await fetch(`http://localhost:3000/address/${onchain}/utxo`)).json()
  return utxos.some((u) => u.value === 3_000)
})

console.log('bob sends everything back to alice')
await settle(bob, await bob.send(alice.address, 5_000))
await until('bob is empty', async () => (await balance(bob)) === 0)

console.log('alice pays bob from several coins')
const { vtxos } = await alice.coins()
const largest = Math.max(...vtxos.map((v) => v.amount))
await settle(alice, await alice.send(bob.address, largest + 1_000))
await until('bob is paid again', async () => (await balance(bob)) === largest + 1_000)

console.log('ok')

function read(p) {
  return JSON.parse(readFileSync(new URL(p, import.meta.url)))
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function until(what, check, seconds = 180) {
  for (let i = 0; i < seconds / 2; i++) {
    const got = await check()
    if (got) return got
    await sleep(2000)
  }
  throw new Error(`timed out: ${what}`)
}

async function settle(wallet, spend) {
  console.log(`  ${spend.kind} ${spend.amount} sats, change ${spend.change}: ${spend.id}`)
  let last = ''
  await until(`spend ${spend.id}`, async () => {
    const s = await wallet.spendStatus(spend.id)
    if (s.error && s.error !== last) console.log(`  attempt failed: ${(last = s.error)}`)
    if (s.status === 'expired' || s.status === 'cancelled') throw new Error(`spend ${s.status}: ${s.error}`)
    if (s.status === 'done' && !s.sent) throw new Error('coins spent by something else')
    return s.status === 'done'
  })
}

async function balance(w) {
  return (await w.coins()).vtxos.reduce((n, v) => n + v.amount, 0)
}
