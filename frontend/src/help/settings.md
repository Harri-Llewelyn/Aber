## Summary

Platform settings an administrator owns: retention windows, thresholds, and the switches that decide what the stack does on its own. Everything here is a stored value with a name, and every change lands in the Audit Trail as a row.

## What the controls do

- **Each setting carries its own bounds.** A retention window has a floor and a ceiling, and the field refuses a value outside them -- because the settings most worth changing are the ones where a typo is a silent outage weeks later, not an error today.
- **Enabled / Disabled** switches turn scheduled behaviour on and off. They take effect on the next run of whatever they gate, not retroactively.
- **The `?` beside each field** explains what the setting actually controls. It is worth reading before the value is changed, because several of them read like each other and act very differently.

## What the states mean

A setting shows the value in force now. Where a setting bounds a background job -- pruning, tiering, retention -- changing it changes what that job does next time it runs; it does not reach back and undo what it already did.

## What is not here

**Nothing secret is stored on this page.** Passwords, keys and broker credentials are not settings: they live in the deployment's own secret store and are issued through Access Control. A page that mixed the two would make every routine settings change look like a credential change in the audit trail, and make the audit trail worth less.

Alert thresholds are not here either. Grafana owns those, along with silences and state history -- this stack links to them rather than mirroring them, so there is one place a threshold can be wrong.
