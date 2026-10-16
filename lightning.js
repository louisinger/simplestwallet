// Lightning addresses through an lnurl-server. Nothing here signs: paying one is
// an ordinary send to the Arkade address the server answers with.
import { createLnurlClient, deriveSessionToken } from '@arkade-os/lnurl-client'
import { hex } from '@scure/base'

export { isValidLnUrl } from '@arkade-os/lnurl-client'

// lightningAddress claims the wallet's address, or finds it again: the token derives from the key
export async function lightningAddress(w, baseUrl) {
  const client = createLnurlClient({ baseUrl })
  const { domain } = await client.domainCapabilities()
  const token = deriveSessionToken(hex.encode(w.priv), domain)
  const address =
    (await client.listAddresses(token)).find((a) => a.status === 'active' && a.lightningAddress) ??
    (await client.registerAddress({ token, domain }))
  // the server overwrites, so binding on every open also covers a restored key
  await client.registerArkadeIdentity({
    token, domain, handle: address.handle,
    arkadeAddress: w.address, claimPublicKey: hex.encode(w.owner), boardingAddress: w.boardingAddress,
  })
  return address.lightningAddress
}

export async function payLightning(w, target, amountSat) {
  const payer = createLnurlClient()
  const request = await payer.resolve(target)
  const rail = request.paymentOptions?.find((o) => o.type === 'arkade' && o.available !== false)
  if (!rail) throw new Error('This address takes Lightning only. This wallet pays over Arkade.')
  const res = await payer.requestInvoice(request, { amountSat, paymentOption: rail.id })
  if (res.kind !== 'destination' || !res.paymentDestination) throw new Error('The address gave no Arkade destination.')
  // delegatee's templates have nowhere to put a memo, and a payment without it is lost
  if (res.paymentDestinationTag) throw new Error('This address needs a memo this wallet cannot attach.')
  return w.send(res.paymentDestination, amountSat)
}
