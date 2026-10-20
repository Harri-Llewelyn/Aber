# Bringing your own edge node

An **edge node** is the computer, and the software on it, that sends your machines' data to Aber's
[broker](../guides/glossary.md#broker). Aber's gateway appliance is one. You may connect an edge
node of your own choosing instead: equipment with [Sparkplug B](../guides/glossary.md#sparkplug-b)
built in, or software you picked for a protocol or a data rate.

**Making that node meet Aber's requirements is your responsibility.** Aber does not test or certify
it. This page lists what it must do, as a checklist. Each item says what happens when it is not met,
and links to the reference page with the detail.

The requirements are stated against Sparkplug B 3.0.0 and Aber's own behaviour. Each Sparkplug rule
gives its `tck-id`: the name the specification gives that statement, which its test kit (the TCK)
checks.

## Words on this page

- **Birth:** the message that announces a node (NBIRTH) or a device (DBIRTH), and every metric it
  will send. **Death:** the message that says it has gone (NDEATH).
- **Data:** a message carrying new readings, for the node (NDATA) or a device (DDATA).
- **bdSeq:** a number in the node's birth and death that says which connection they belong to.
- **seq:** a number in every message after the birth, one more each time, so a missing message shows.
- **STATE:** the message Aber's ingestion service publishes to say whether it is online. Aber's
  **primary host ID** names it.
- **QoS:** how hard MQTT tries to deliver a message. QoS 0 is sent once. QoS 1 is repeated until it
  arrives.

## Before you start

- An Administrator or a Shopfloor Manager registers the node in the dashboard.
- The node needs a network route to the broker's TLS port, usually `8883`.
- The node must support Sparkplug B 3.0.0, with MQTT over TLS and a primary host ID setting.

## The checklist

1. **Register the node as a Third-party gateway, and issue its credential.** On the **Gateways**
   page, choose **New Gateway**, set **Type** to **Third-party**, and save. The credential dialog
   opens with every setting below, each with a copy button. **If you skip this,** the broker has no
   account for the node and refuses it. An Administrator can show the password again from the
   gateway's drawer.
2. **Connect to the broker's TLS port, trusting Aber's root certificate, with the username and
   password issued.** The dialog gives the broker address, the TLS port and the root certificate to
   download. Install the root in the node's trust store, and keep certificate checking on. **If it
   is wrong,** the connection fails and the gateway stays offline. A node that does not check the
   certificate would send its password to anything that answers on that address
   ([certificates](../../docs/remote-gateways.md#8-certificates-and-the-two-clocks-they-run-on)).
3. **Publish as the gateway.** The edge node ID is the gateway's Sparkplug ID, which is also the
   username. Every topic is `spBv1.0/<group>/<message>/<edge node ID>`, under the gateway's
   [Sparkplug group](../guides/glossary.md#sparkplug-group) (`tck-id-topic-structure`). **If the ID
   is wrong,** the broker drops every message without an error, so nothing arrives. **If the group
   is wrong,** Aber still stores the data, and the Gateways page warns that the gateway publishes
   under another group ([adding devices](../../docs/remote-gateways.md#10-adding-devices--nothing-is-pre-registered)).
4. **Hold a Sparkplug session.** Connect with an NDEATH as the MQTT Will, at QoS 1, carrying a bdSeq
   one more than the last connection's (`tck-id-message-flow-edge-node-birth-publish-will-message`,
   `tck-id-message-flow-edge-node-birth-publish-will-message-payload-bdSeq`,
   `tck-id-message-flow-edge-node-birth-publish-will-message-qos`). Subscribe to the node's NCMD
   topic at QoS 1 before the birth (`tck-id-message-flow-edge-node-ncmd-subscribe`). Send the NBIRTH
   with the same bdSeq as the Will (`tck-id-message-flow-edge-node-birth-publish-nbirth-payload-bdSeq`,
   `tck-id-payloads-nbirth-bdseq-repeat`). Use one seq across the node and all its devices, one more
   in each message, wrapping from 255 to 0 (`tck-id-payloads-sequence-num-incrementing`). Publish
   births and data at QoS 0 (`tck-id-payloads-nbirth-qos`, `tck-id-payloads-dbirth-qos`,
   `tck-id-payloads-ndata-qos`, `tck-id-payloads-ddata-qos`). Before you disconnect on purpose,
   publish the NDEATH (`tck-id-operational-behavior-edge-node-intentional-disconnect-ndeath`).
   **If it does not,** Aber cannot tell one connection from the next. A death that names no
   connection can mark a live gateway offline, and a gap in seq makes Aber ask for a rebirth
   ([a death from an earlier session](../../ingestion/README.md#a-death-from-an-earlier-session)).
   Aber also expects a node message at least every 90 seconds, and a message from each device at
   least every 5 minutes by default. Sparkplug does not ask for these, so a node that sends only changes may
   need a regular refresh. **If the node is quieter,** the gateway reads STALE and its devices
   OFFLINE until they speak, although nothing they send is lost
   ([device liveness](../../ingestion/README.md#device-liveness-watchdog)).
5. **Declare every metric in a birth, with its datatype.** The NBIRTH lists every node metric, and
   each DBIRTH every metric of its device, that the session will send
   (`tck-id-operational-behavior-data-publish-nbirth`,
   `tck-id-operational-behavior-data-publish-dbirth`, `tck-id-payloads-metric-datatype-req`).
   Aliases are allowed. **If it does not,** an alias Aber was not told about is skipped. A signed
   number with no declared datatype is stored as a large positive one
   ([metric aliases](../../ingestion/README.md#metric-aliases)).
6. **Answer rebirth commands.** Aber asks with `Node Control/Rebirth` on the node's NCMD topic. The
   NBIRTH declares that metric (`tck-id-operational-behavior-data-commands-rebirth-name`), as a
   Boolean (`tck-id-operational-behavior-data-commands-rebirth-datatype`).
   On a request, stop sending data, then send the NBIRTH and every DBIRTH again with the same bdSeq
   (`tck-id-operational-behavior-data-commands-rebirth-action-1`,
   `tck-id-operational-behavior-data-commands-rebirth-action-2`,
   `tck-id-operational-behavior-data-commands-rebirth-action-3`). **If it does not,** a lost change
   waits for the node's next report. After Aber restarts, an aliased node's readings are not stored
   until it births again ([rebirth requests](../../ingestion/README.md#rebirth-requests-ncmd)).
7. **Watch the primary host.** Set the node's primary host ID to the one the dialog gives. The node
   then waits for `spBv1.0/STATE/<primary host ID>` to say online before it births
   (`tck-id-message-flow-edge-node-birth-publish-phid-wait`). When it says offline, the node sends
   its NDEATH and connects again (`tck-id-message-flow-edge-node-birth-publish-phid-offline`).
   Keep readings while Aber is offline. Send them after the next birth with `is_historical` set on
   each metric, and pace them. **If it does not,** readings sent while Aber restarts are lost. A
   replay that is not marked historical and is more than 24 hours old is refused. A replay that is
   too fast fills Aber's queue, and readings are dropped
   ([the primary host id](../../docs/remote-gateways.md#the-third-value-the-primary-host-id),
   [loss model](../../ingestion/README.md#loss-model)).
8. **Keep the clock right.** Set the node's clock from a time server. Aber refuses a reading that is
   more than 24 hours old, or more than 5 minutes in the future. A reading marked `is_historical`
   may be up to 7 days old. **If the clock is wrong,** readings are refused for their timestamp, and
   an alert fires. A clock far enough off also fails the certificate check
   ([late data](../../docs/remote-gateways.md#late-data-after-an-outage),
   [the clock](../../docs/remote-gateways.md#the-clock-is-part-of-certificate-verification)).
9. **Expect devices to wait in quarantine.** A device's first DBIRTH puts it in
   [quarantine](../guides/glossary.md#quarantine). Its data is dropped until someone approves it
   on the **Devices** page. **If nobody approves it,** the device's readings are never stored
   ([quarantine](../../ingestion/README.md#quarantine)).
10. **Optionally, report what an outage cost.** After an outage, put the `Outage/` metrics in the
    next node messages: when it started and ended, and how many readings were kept and dropped. The
    `Outage/` prefix is reserved, so use it for nothing else. **If you leave it out,** nothing
    breaks, but the dashboards cannot show what the outage cost
    ([the outage report](../../docs/remote-gateways.md#the-outage-report)).

## What such a node does not get

Aber does not manage the software on your node, so it gives it less than its own appliance:

- **No setup bundle or install command.** You configure the node by hand, from the dialog.
- **No forge repository.** Change the node on the node itself.
- **No flow drift check.** Aber cannot see what the node runs.
- **No appliance health.** The drawer shows no root expiry, disk, memory or load for it.
- **No automatic root update.** When Aber's root certificate is re-issued, install the new root in
  the node's trust store before the old one is retired
  ([rotating the root](../../docs/remote-gateways.md#rotating-the-root-in-the-order-that-matters)).
  Aber cannot tell whether your node holds the new root, so the Gateways page says nothing about it.

## Check the node

1. **Run the Sparkplug TCK's Edge Node profile against it.** The TCK is the test kit published with
   Sparkplug B 3.0.0. It tests the `tck-id` statements above.
2. **Watch the gateway on the Gateways page.** It shows **ONLINE** once the node has sent its birth.
3. **Ask for a rebirth.** Choose **Request Rebirth** in the gateway's drawer. The node births again
   within a few seconds.
4. **Find its devices.** Each one appears in quarantine on the **Devices** page. Approve them there.
5. **Look for a warning.** No **Publishes under group** line appears under the gateway's name.

## Where the detail is

- [Remote gateways](../../docs/remote-gateways.md): the primary host, certificates, devices, and
  what Aber's appliance does at each step.
- [Ingestion](../../ingestion/README.md): how Aber reads each message, and where a reading can be lost.
- [The broker](../../mosquitto/README.md): the accounts and roles that confine each gateway.
