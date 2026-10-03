## Summary

One queue for every change somebody proposes but may not make themselves. An Operator proposes; an Administrator or Shopfloor_Manager approves — and approving is what performs the change. Nothing is written when a proposal is filed.

A machine identity can propose too, if an Administrator gave it that permission. Its proposals name it by the name it was given, marked **machine**, and a person still decides them.

## What the controls do

- There is no form on this page. A change is asked for on the entity's own page: open the device, area, cell or gateway and use **Propose a Change**, which opens the same dialog that edits it. A nameplate change starts from the device's **Digital Nameplate…**. Change only what you want changed, and say why. A field you leave alone is not part of the proposal.
- The page has two tabs: **Awaiting a decision**, where it opens, and **Decided**. While proposals you may decide are waiting, the Awaiting tab carries a warning mark and how many; your own proposals and kinds you may not decide are not counted.
- Selecting a row, by clicking it or with Enter, opens the proposal beside the list; selecting it again closes it. What it shows depends on the status:
  - **What would change**, while it is open: each field, its value **Now** and the value **Proposed**. A field already at the proposed value is marked **unchanged**.
  - **What changed**, once applied: each field **Before** and **After**. Before comes from the Audit Trail row the approval wrote, because the entity now holds After. If you may not read that row, only After is shown, with a note saying so.
  - **What was proposed**, once rejected, withdrawn or expired: the **Proposed** values alone. Nothing was changed, and today's value may have moved since.
- A subject that no longer exists is marked **MISSING**, and approving it fails rather than recreating anything.
- **Approve** applies the change there and then, in one transaction, as you. **Reject** refuses it and requires a reason. **Withdraw** is your own proposal's exit, and only the person who filed it can use it.
- **Add to this proposal** takes you to the entity's page with your open proposal loaded into its dialog, so you can add to it rather than filing a second one.
- Each tab has its own **kind** filter, whose options say how many proposals each kind holds, a search box (the subject, the proposer, the reason or rationale, or an id) and **Clear filters**.
- The columns are **Subject**, **Change** (the kind of change), **Field(s) changed**, **Status** and **When**. Hover a time for the full date. The drawer adds who proposed it, when it was proposed and decided, the reason, the rationale, the proposal's UUID and the Audit Trail row.
- The database decides which fields a proposal may name, and checks again at approval. The dialog disables a field no proposal may name, and says why.

## What the states mean

**Awaiting a decision** is the working queue, oldest first, because a queue is worked from the front. **Decided** is the record, newest decision first.

- **applied** — approved, and the change was made. The Audit Trail carries a row naming both the person who asked and the person who authorised it, and **View in Audit Trail** on the proposal opens the Audit Trail filtered to that entity's kind and searching for its id, with deleted entities shown if the target is gone. It does not select the row. Only an applied proposal has one: the other three outcomes changed nothing.
- **rejected** — refused, with a reason. The slot is freed immediately and the same change can be proposed again straight away; the reason is what should make the second attempt different from the first.
- **withdrawn** — the proposer took it back.
- **expired** — nobody decided in time and it closed on a timer. It names no approver, because a timer is not a person. The Administrator sets the window on the Settings page.

## Two limits, and what to do when you meet one

**One open proposal per asset, per person.** If you are told you already have one, open it and add to it — the refusal offers a button that takes you straight there. The limit exists so three edits to the same machine arrive as one coherent change rather than three, and it is scoped to **you**, so your forgotten proposal never blocks a colleague from proposing against the same machine.

**A ceiling on how many proposals you can have open at once.** This one bounds how much is queued for reviewers. Decide or withdraw something before adding more. The number is a setting an Administrator owns.

## The kinds of change, and who decides them

A proposal is filed as one kind of change, for the kind of entity it changes, and names only the fields that kind lists.

- **Device details** — name, description, connection method, and where it sits: cell, area and location scope. Not its type or its 3D model.
- **Device nameplate** — the Digital Nameplate: manufacturer, product designation and type, serial number, year of construction, date of manufacture, hardware, firmware and software versions, country of origin and product URI.
- **Area details** — name, description and icon. The name is also a segment of every `uns/` topic beneath the area.
- **Cell details** — name, description, Grafana dashboard, icon, and its area and place on the plan.
- **Gateway details** — name, description, access URL, and where it sits: cell, area and location scope. Not what it is, such as its deployment, and not what the platform observed about its health.

An Administrator or a Shopfloor_Manager decides every lane. A machine identity never does: it may propose, but nothing it can be granted lets it approve.

A proposal to publish a schema draft is a kind that no longer exists. Nothing can be filed as one and nobody can decide one: whoever may create a schema draft may also publish it, on the Schemas page. An old one still appears in the record under its raw name.

## What this page cannot do

**It cannot approve something invalid.** Because the approval performs the write, every constraint on the target runs at that moment — so a proposal that would break a rule fails **at approval** and stays open, with the database's own explanation. That is deliberate: a queue that accepted a change it could not apply would record something that never happened.

**It is not a way around a permission.** Proposing is a write to this queue and to nothing else. An Operator still cannot edit a device, its nameplate, an area, a cell or a gateway directly, and approving runs as the approver with their authority re-checked by the database — never as the proposer.

**It does not cover Node-RED flows.** A gateway's flow lives in its own repository in the forge, and a change to it is a pull request that an administrator approves there. The Gateways page's help describes it.
