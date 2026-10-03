## Summary

Platform settings an administrator owns: retention windows, thresholds, and the switches that decide what the stack does on its own. Everything here is a stored value with a name, and every change lands in the Audit Trail as a row.

## What the controls do

- **The category tabs** switch between groups of settings, one group on screen at a time. The list scrolls inside the card. A setting found from the search box (Ctrl+K) opens on its tab, scrolled into view and highlighted.
- **Save** and **Discard** appear beside the field only once its value has changed. A save is refused by the database if the value is outside its bounds or your role may not change it, and the message says which.
- **Each setting carries its own bounds.** A retention window has a floor and a ceiling, and the field refuses a value outside them -- because the settings most worth changing are the ones where a typo is a silent outage weeks later, not an error today.
- **Enabled / Disabled** switches turn scheduled behaviour on and off. They take effect on the next run of whatever they gate, not retroactively.
- **The `?` beside each field** explains what the setting actually controls. It is worth reading before the value is changed, because several of them read like each other and act very differently.
- **The line beneath a label** shows the setting's key, which copies when clicked, and what applies if the setting has never been changed (**falls back to**). Where that fallback is a `values.yaml` path or a single identifier, it copies too.
- **A read-only setting** shows **set by** and the place it is set, in a greyed field: the Sparkplug group and the archive site key are fixed when the stack is installed and cannot be changed here. Changing the group would re-address every gateway.

## What the states mean

A setting shows the value in force now. Where a setting bounds a background job -- pruning, tiering, retention -- changing it changes what that job does next time it runs; it does not reach back and undo what it already did.

A setting takes effect without a restart and overrides the environment default it names. The list is fixed: a setting appears here because code reads it, so new ones arrive with the feature that needs them and are never added by hand.


## What is not here

**Nothing secret is stored on this page.** Passwords, keys and broker credentials are not settings: they live in the deployment's own secret store. The S3 secret keys are set on Cold Storage and in the Backups destination dialog, and broker credentials are issued on Access Control. A page that mixed the two would make every routine settings change look like a credential change in the audit trail, and make the audit trail worth less.

Alert thresholds are not here either. Grafana owns those, along with silences and state history -- this stack links to them rather than mirroring them, so there is one place a threshold can be wrong.
