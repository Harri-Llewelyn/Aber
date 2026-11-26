### From 1.10.0, a registered device held in Quarantine again is not deleted

A device that was registered before and is held in Quarantine again has no **Reject**. There is nothing to
run.

- **What is refused.** A `DELETE` of such a device, through PostgREST or with the service key, while it is
  not archived. The answer is HTTP 400, and `message` is a sentence that names the device.
- **What to do.** Use **Approve & Onboard** to admit the device again. Its schemas, nameplate and links are
  kept. To delete it, archive it first. **Permanent Delete** and the nightly purge then delete it as before.
- **What is not changed.** A device nobody registered is rejected as before.
