## Summary

One queue for every change somebody proposes but may not make themselves. An Operator proposes; an Administrator or Shopfloor_Manager approves — and approving is what performs the change. Nothing is written when a proposal is filed.

A machine identity can propose too, if an Administrator gave it that permission. Its proposals name it by the name it was given, marked **machine**, and a person still decides them.

## What the controls do

- **Propose a change** opens the composer. Pick what kind of change it is, pick the asset, fill in only the fields you want changed, and say why. A field you leave alone is not part of the proposal.
- **Approve** applies the change there and then, in one transaction, as you. **Reject** refuses it and requires a reason. **Withdraw** is your own proposal's exit, and only the person who filed it can use it.
- **Edit** reopens your own proposal while it is still open, so you can add to it rather than filing a second one.
- The fields the composer offers come from the database, not from this page. A field that is not offered is one no proposal may name.

## What the states mean

**Awaiting a decision** is the working queue, oldest first, because a queue is worked from the front. **Decided** is the record, newest first.

- **applied** — approved, and the change was made. The Digital Thread carries a row naming both the person who asked and the person who authorised it, and **View in Digital Thread** on the proposal opens the target's history at it. Only an applied proposal has one: the other three outcomes changed nothing.
- **rejected** — refused, with a reason. The slot is freed immediately and the same change can be proposed again straight away; the reason is what should make the second attempt different from the first.
- **withdrawn** — the proposer took it back.
- **expired** — nobody decided in time and it closed on a timer. It names no approver, because a timer is not a person. The Administrator sets the window on the Settings page.

## Two limits, and what to do when you meet one

**One open proposal per asset, per person.** If you are told you already have one, open it and add to it — the refusal offers a button that takes you straight there. The limit exists so three edits to the same machine arrive as one coherent change rather than three, and it is scoped to **you**, so your forgotten proposal never blocks a colleague from proposing against the same machine.

**A ceiling on how many proposals you can have open at once.** This one bounds how much is queued for reviewers. Decide or withdraw something before adding more. The number is a setting an Administrator owns.

## Who can approve what

Not every lane has the same approver, and this is deliberate rather than an oversight.

- **Device details** and **Device nameplate** — an Administrator or a Shopfloor_Manager.
- **Schema publication** — an **Administrator only**. Publishing a schema decides what ingestion accepts as conformant across every device attached to it, which is a platform decision rather than a shopfloor one.

So a Shopfloor_Manager who approves nameplate edits all day will not see Approve on a schema proposal. That is the gate, not a fault.

## What this page cannot do

**It cannot approve something invalid.** Because the approval performs the write, every constraint on the target runs at that moment — so a proposal that would break a rule fails **at approval** and stays open, with the database's own explanation. That is deliberate: a queue that accepted a change it could not apply would record something that never happened.

**It is not a way around a permission.** Proposing is a write to this queue and to nothing else. An Operator still cannot edit a device, a nameplate or a schema directly, and approving runs as the approver with their authority re-checked by the database — never as the proposer.

**It does not cover Node-RED flows yet.** A flow lives on the gateway rather than in a column here, and that lane is still to be built.
