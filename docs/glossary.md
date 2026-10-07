# Glossary

The words Aber's documentation and dashboard use, in plain terms. Each entry links to where the
subject is covered in depth.

## Your site and its equipment

### Area

A part of your site, such as a hall, a yard or a plant room. Areas hold cells. The levels follow
[ISA-95](#isa-95).

### Cell

A line or a bay on the shopfloor, inside an area. Gateways and devices are placed in cells, and
most filters in the dashboard come down to which cell something is in.

### Device

A machine, or part of one, whose data a gateway sends to Aber. Most devices are not created by
hand: one appears when its gateway first announces it, and someone then names it, places it and
gives it a [schema](#schema).

### Gateway

The computer that talks to your machines and sends their data to Aber's [broker](#broker). There
are four types:

- **Remote:** runs on its own hardware beside the machines. It is the usual type
  ([remote gateways](remote-gateways.md)).
- **Host:** runs inside the server's own Node-RED.
- **Simulated:** for synthetic data, such as a Node-RED flow that imitates a machine. It runs
  inside the server, and its devices are kept apart from real ones.
- **Playback:** replays recorded traffic (see [capture and playback](#capture-and-playback)).
  Every install has exactly one.

### Appliance

The computer a Remote gateway runs on, once it has been set up with the install command or the
bundle from the dashboard.

### Asset

Anything Aber tracks on the shopfloor: areas, cells, gateways and devices.

## Data

### Metric

One named value a device sends, such as a temperature or a spindle speed. It has a datatype and a
meaning.

### Schema

What a kind of device is expected to send: which metrics, of which datatype, meaning what. Giving a
device a schema is what makes its data readable by queries, dashboards and other systems.

### Vocabulary

A published standard's list of metrics, such as MTConnect or OPC UA, that schemas are built from
([vocabularies](vocabularies.md)).

### Quarantine

Where a device Aber does not recognise waits until an administrator approves it. Its data is
dropped until then.

### Historian

The database that keeps every reading over time. Aber's is [TimescaleDB](#timescaledb).

### Rollup

A summary of readings over a fixed period: a minute, five minutes or an hour. Rollups are kept far
longer than the raw readings, which are kept for 14 days by default.

### Cold archive

An optional copy of old raw readings in S3-compatible storage, made before they are removed from
the historian.

### Capture and playback

A capture records the traffic the broker carried. Playback sends it again later through the
Playback gateway.

### Audit Trail

The record of every change: what changed, who changed it, and what it looked like before. It can
only ever be added to.

## Gateways and their flows

### Node-RED

A visual tool for wiring together data flows. Each gateway runs Node-RED, and its flow says how to
read the machines and what to send.

### Flow

A Node-RED program. A Remote gateway's flow is kept in the [forge](#forge).

### Forge

Aber's built-in git server, which runs Gitea. It holds each Remote gateway's flow, and a change is
approved there before the gateway runs it.

### Broker

The server that receives [MQTT](#mqtt) messages and passes them on. Aber's broker is Mosquitto.

## People and access

### Roles

What a person may do in Aber:

| Role | May |
| :--- | :--- |
| `Administrator` | Everything, including access control |
| `Shopfloor_Manager` | Create and change equipment, and approve changes |
| `Operator` | Read, and propose changes for someone else to approve |
| `Auditor` | Read the Audit Trail |

### Approvals

The queue of changes someone proposed but may not make themselves. Approving a proposal is what
makes the change.

### Machine identity

An account held by software rather than a person, such as the ingestion service. It cannot sign
in, and it holds only the permissions it needs ([security model](security-model.md#machine-identities)).

## Standards

### MQTT

A lightweight messaging protocol for devices. A device publishes messages to a broker, and other
programs subscribe to the ones they want.

### Sparkplug B

An open standard for industrial data over MQTT. It fixes the topic names and the message format,
so any gateway that follows it can send data to Aber.

### Factory+

A framework from the AMRC for connecting factory systems, built on Sparkplug B. Aber is compatible
with parts of it ([relationship to ACS](architecture.md#relationship-to-acs)).

### ACS

The AMRC Connectivity Stack, the AMRC's implementation of Factory+. It inspired Aber, which is an
independent project.

### ISA-95

An international standard for describing a manufacturing site in levels: site, area, cell and
equipment. Aber organises your equipment by its levels.

### Unified Namespace (UNS)

One place where every reading on a site is published, on MQTT topics named by the site's ISA-95
levels. Any program with a broker connection can read it. It is off by default.

### Asset Administration Shell (AAS)

A standard digital description of a piece of equipment (IEC 63278). Aber exports devices as AAS
files.

### i3X

An open API standard from CESMII for reading industrial data. Aber runs an i3X server, so other
software can browse and read its data ([`i3x/README.md`](../i3x/README.md)).

## Software Aber is built from

### Supabase

A backend built on PostgreSQL: a database, sign-in, an API and file storage. Aber keeps its
equipment register and its accounts there.

### TimescaleDB

A PostgreSQL extension for data that arrives over time. It is Aber's [historian](#historian).

### Grafana

Dashboards and charts. Aber uses it to chart readings and to raise alerts.

### Kubernetes

Software that runs and looks after containers on one or more machines.

### k3s

A small Kubernetes that runs on a single machine. Aber's server runs on it.

### k3d

k3s running inside Docker, for working on Aber's code on a laptop.

### Helm

The package manager for Kubernetes. A package is called a *chart*, and Aber is installed as one.

## Installing and running

### Site

One installation of Aber, and the place it serves. Each site has its own server, gateways and
accounts.

### Sparkplug group

The name a site's gateways publish under, set once at install as `ingestion.sparkplugGroup`. It
cannot be changed afterwards.

### Internal CA and root certificate

Aber issues its own certificates for HTTPS and the broker, from a certificate authority (CA) that
runs inside the server. Browsers and gateways trust those certificates once the CA's *root
certificate* is installed on them ([runbook, *TLS*](../deploy/k8s/README.md#tls)).

### Edge function

A small program on the server that handles one job in Aber's API, such as enrolling a gateway.
