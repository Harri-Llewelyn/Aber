### From 1.10.0, a merge from Quarantine is refused for a registered device

A device that was registered before and is held in Quarantine again is offered no match. There is nothing
to run.

- **What is refused.** **Accept Match**, or a call of `approve-quarantine` with `merge_into_device_id`. It
  is refused when the held device was registered before or is no longer in Quarantine. It is also refused
  when the other device is archived, is in Quarantine, or has sent its first birth.
- **The answer is HTTP 409,** and `error` is a sentence that names the device.
- **What to do.** Use **Approve & Onboard** to admit the device again. Its schemas, nameplate and links are
  kept.
- **Devices held at the upgrade.** The Audit Trail says which were registered before. db-init's log
  counts them.
