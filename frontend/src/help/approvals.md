## What this page is for

This page is the one queue for every change that somebody proposes but may not make themselves. An Operator proposes, and an Administrator or Shopfloor_Manager approves. Approving is what makes the change. Nothing is written when a proposal is filed.

A machine identity can propose too, if an Administrator gave it that permission. Its proposals show the name it was given, marked **machine**, and a person still decides them.

## What the controls do

- There is no form on this page. You ask for a change on the page of the thing you want changed. Open the device, area, cell or gateway and use **Propose a Change**, which opens the same dialog that edits it. A nameplate change starts from the device's **Digital Nameplate…**. Change only what you want changed, and say why. A field you leave alone is not part of the proposal.
- The page has two tabs: **Awaiting a decision**, where it opens, and **Decided**. While proposals you may decide are waiting, the Awaiting tab shows a warning mark and how many. Your own proposals, and kinds you may not decide, are not counted.
- Selecting a row, by clicking it or pressing Enter, opens the proposal beside the list. Selecting it again closes it. What it shows depends on the status:
- **What would change**, while it is open: each field, its value **Now** and the value **Proposed**. A field already at the proposed value is marked **unchanged**.
- **What changed**, once applied: each field **Before** and **After**. Before comes from the Audit Trail row the approval wrote, because the entity now holds After. If you may not read that row, only After is shown, with a note saying so.
- **What was proposed**, once rejected, withdrawn or expired: the **Proposed** values alone. Nothing was changed, and today's value may have moved on since.
- A subject that no longer exists is marked **MISSING**. Approving it fails, rather than recreating anything.
- **Approve** makes the change there and then, in one transaction, as you. **Reject** refuses it, and needs a reason. **Withdraw** takes back your own proposal, and only the person who filed it can use it.
- **Add to this proposal** takes you to the entity's page with your open proposal loaded into its dialog. You can then add to it rather than filing a second one.
- Each tab has its own **kind** filter, a search box and **Clear filters**. The kind filter's options say how many proposals each kind holds. The search matches the subject, the proposer, the reason or rationale, or an id.
- The columns are **Subject**, **Change** (the kind of change), **Field(s) changed**, **Status** and **When**. Hover a time for the full date. The drawer adds who proposed it, when it was proposed and decided, the reason, the rationale, the proposal's UUID and the Audit Trail row.
- The database decides which fields a proposal may name, and checks again at approval. The dialog disables a field no proposal may name, and says why.

## What the states mean

**Awaiting a decision** is the working queue, oldest first, because a queue is worked from the front. **Decided** is the record, newest decision first.

- **applied**: approved, and the change was made. The Audit Trail has a row naming both the person who asked and the person who authorised it.
- **View in Audit Trail**, on an applied proposal, opens the Audit Trail filtered to that entity's kind and searching for its id. If the target is gone, deleted entities are shown too. It does not select the row. Only an applied proposal has this button, because the other three outcomes changed nothing.
- **rejected**: refused, with a reason. The slot is freed at once, and the same change can be proposed again straight away. The reason is what should make the second attempt different from the first.
- **withdrawn**: the proposer took it back.
- **expired**: nobody decided in time, and it closed on a timer. It names no approver, because a timer is not a person. The Administrator sets the window on the Settings page.

## Two limits, and what to do when you meet one

**One open proposal per asset, per person.** If you are told you already have one, open it and add to it. The refusal offers a button that takes you straight there. The limit means three edits to the same machine arrive as one change rather than three. It applies to **you** alone, so your forgotten proposal never blocks a colleague from proposing a change to the same machine.

**A ceiling on how many proposals you can have open at once.** This one limits how much is queued for reviewers. Decide or withdraw something before adding more. The number is a setting an Administrator owns.

## The kinds of change, and who decides them

A proposal is filed as one kind of change, for the kind of entity it changes. It names only the fields that kind lists.

- **Device details**: name, description, connection method, and where it sits (cell, area and location scope). Not its type or its 3D model.
- **Device nameplate**: the Digital Nameplate. That is manufacturer, product designation and type, serial number, year of construction and date of manufacture. It also covers hardware, firmware and software versions, country of origin and product URI.
- **Area details**: name, description and icon. The name is also a segment of every `uns/` topic beneath the area.
- **Cell details**: name, description, Grafana dashboard, icon, and its area and place on the plan.
- **Gateway details**: name, description, access URL, and where it sits (cell, area and location scope). Not what it is, such as its deployment, and not what Aber observed about its health.

An Administrator or a Shopfloor_Manager decides every kind. A machine identity never does: it may propose, but nothing it can be granted lets it approve.

The record may show an old proposal to publish a schema draft, under its raw name. That kind can no longer be filed or decided. Whoever may create a schema draft may also publish it, on the Schemas page.

## What this page cannot do

**It cannot approve something invalid.** Approving is what writes the change, so every rule on the target is checked at that moment. A proposal that would break a rule fails **at approval** and stays open, with the database's own explanation. This is on purpose: otherwise the queue would record a change that never happened.

**It is not a way around a permission.** Proposing writes to this queue and to nothing else. An Operator still cannot edit a device, its nameplate, an area, a cell or a gateway directly. Approving runs as the approver, never as the proposer, and the database checks the approver's authority again.

**It does not cover Node-RED flows.** A gateway's flow lives in its own repository in the forge. A change to it is a pull request, which an administrator approves there. The Gateways page's help describes how.
