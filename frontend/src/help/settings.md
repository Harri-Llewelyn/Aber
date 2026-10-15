## What this page is for

This page holds the settings an Administrator owns. They cover how long things are kept, thresholds, and switches for what Aber does on its own. Each setting is a stored value with a name, and every change is recorded in the Audit Trail as a row.

## What the controls do

- **The category tabs** switch between groups of settings, one group at a time. The list scrolls inside the card. A setting you find with the search box (Ctrl+K) opens on its tab, scrolled into view and highlighted.
- **Each tab is a table** with four columns. **Setting** holds the name, with its key beneath it. Click the key to copy it. **Description** says what the setting controls. **Value** holds the field. **Actions** holds Save and Discard.
- **Read the description before you change a value.** Several settings sound alike and act very differently.
- **The grey line under a description** says what applies if the setting has never been changed (**Falls back to**). Where that is a `values.yaml` path or a single identifier, it copies too.
- **Save** and **Discard** appear in Actions only once you change the value. The database refuses a save if the value is out of bounds or your role may not change it, and the message says which.
- **Each setting carries its own bounds.** A retention window has a floor and a ceiling, and the field refuses a value outside them. The range is written beneath the field, for example **7 to 3650**. That way a typo is refused today, rather than causing a silent outage weeks later.
- **Enabled / Disabled** switches turn scheduled jobs on and off. A change takes effect the next time the job runs, and does not undo anything already done.
- **Cold Storage** here holds the archive threshold and the read-only site key. The archive destination, and the switch that turns archiving on, are set in one dialog on the Cold Storage page, so they are not listed here.
- **A read-only setting** shows **Set by** and where it is set, in a greyed field, and **Fixed at install** in Actions. The Sparkplug group and the archive site key are fixed when Aber is installed, and cannot be changed here. Changing the group would change the address of every gateway.
- **When the page is narrow** each setting stacks. The name and key come first, then the value and actions, then the description.

## What the states mean

- A setting shows the value in force now.
- A change takes effect without a restart. It overrides the environment default that the setting names.
- Some settings limit a background job, such as pruning, tiering or retention. Changing one changes what the job does on its next run. It does not reach back and undo what the job already did.
- The list is fixed. A setting is here because Aber's code reads it, so new settings arrive with the feature that needs them. Nobody adds one by hand.

## What is not here

**Nothing secret is stored on this page.** Passwords, keys and broker credentials are not settings. They are kept in the deployment's own secret store. The S3 secret keys are set in the destination dialogs on the Cold Storage and Backups pages. Broker credentials are issued on Access Control. Keeping secrets apart means a routine settings change never looks like a credential change in the Audit Trail.

Alert thresholds are not here either. Grafana owns them, along with silences and alert state history. Aber links to Grafana rather than copying them, so there is only one place a threshold can be wrong.
