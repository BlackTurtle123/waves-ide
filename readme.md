# Waves IDE

## Direct Ledger signing

In **Sign and publish**, choose **Ledger (USB)**. Use desktop Chrome (or another
WebUSB browser) over trusted HTTPS, connect the device by USB, and open its Waves
app. Click **Connect Ledger** to load the first ten addresses. Choose your address
from the **Ledger address** list and confirm it on the device. Use **Load more
addresses** to browse ten subsequent accounts at a time. The selected public key appears in the
IDE. New addresses require one device confirmation. Verified addresses, loaded
pages, and your signer choice for each transaction sender are remembered in this
browser, separately for each device wallet and network. The chosen public key is
read again before reusing a confirmation. **Verify address** explicitly displays
it on the device again. No seeds or private keys are stored by this feature.

The USB connection survives closing and reopening the signing dialog. After a
page reload, connect once to restore the saved addresses and selected signer.
**Disconnect** releases the device; **Switch Ledger** selects another device.
Automatic selection uses your remembered signer for that sender, then an exact
Ledger public-key match to the sender, then your last-used Ledger account. A
batch with conflicting signer choices requires manual selection. This is a
convenience preference, not automatic validation of a contract's multisig policy.
Reconnect after changing networks. Error `0x5515` means the device is PIN-locked: unlock it on the Ledger,
open Waves, and reconnect.

Prepare the transaction with its sender public key, network, timestamp, fee and
version. Choose the proof slot and click **Add sign**. Review the transaction on
Ledger; **Publish** remains a separate action. A Ledger signer may differ from the
transaction sender for multisignature accounts. Existing sender data and other
proof slots are preserved, and each signature is verified against the exact
transaction bytes before it is accepted. Transaction arrays are signed one at a
time; rejecting or cancelling a batch leaves the editor unchanged.

Cancellation also requires dismissing the USB chooser or rejecting the pending
request on the device. Disconnect Ledger from other wallets if the device is busy.
Unsupported transaction versions are rejected by the Waves app; install an app
update if needed. Invoke signing supports at most two payments. Private keys and
seed phrases stay on Ledger.

Run `npm run test:ledger` for signature integrity, multisignature, amount precision,
network, rejection, cancellation and batch-order regression tests. A physical
Ledger check is still required for browser/device/firmware compatibility. With
Node 18+, build this legacy Webpack 4 project using
`NODE_OPTIONS=--openssl-legacy-provider` for the asset and bundle build commands.
## About
This repository contains [Waves Web IDE](https://ide.wavesplatform.com) for RIDE smart contracts
You can set default seed, default network byte and node url via settings.

Console documentation can be found [here](https://github.com/wavesplatform/waves-repl) 
## Usage
##### First steps

Make sure you have node-js > 10.0, else https://nodejs.org/en/download/package-manager/

```npm
npm install
```
##### You need to build monaco editor, mocha, ride language server and ride schemas
```npm
npm run build-monaco && npm run build-mocha && npm run build-language-server && npm run build-schemas
```
##### Run dev server on localhost:8080
```npm
npm start
```
##### Build 
```npm
npm run dist
```
