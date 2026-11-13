## What this page is for

This page holds the settings for the whole site. They apply to everyone on this site. They cover how long things are kept, thresholds, and switches for what Aber does on its own. Each setting is a stored value with a name, and every change is recorded in the Audit Trail as a row.

Everyone can read this page. Only an Administrator can change a setting. For any other role the fields are greyed out, and Actions says **Only an Administrator can change this**.

Your own choices, such as your theme and sidebar layout, are not here. They are on your **Profile** page. Open it from the account menu: select your avatar at the foot of the sidebar, then select **Profile**.

## What the controls do

- **The category tabs** switch between groups of settings, one group at a time. The list scrolls inside the card. A setting you find with the search box (Ctrl+K) opens on its tab, scrolled into view and highlighted.
- **Each tab is a table** with four columns. **Setting** holds the name, with its key beneath it. Click the key to copy it. **Description** says what the setting controls. **Value** holds the field. **Actions** holds Save and Discard.
- **Read the description before you change a value.** Several settings sound alike and act very differently.
- **The grey line under a description** says what applies if the setting has never been changed (**Falls back to**). Where that is a `values.yaml` path or a single identifier, it copies too.
- **Save** and **Discard** appear in Actions only once an Administrator changes the value. The database refuses a save if the value is out of bounds or your role may not change it, and the message says which.
- **Each setting carries its own bounds.** A retention window has a floor and a ceiling, and the field refuses a value outside them. The range is written beneath the field, for example **7 to 3650**. That way a typo is refused today, rather than causing a silent outage weeks later.
- **A setting that counts whole things takes a whole number.** That is every setting counted in days, hours or seconds, and **Open proposals allowed per person**. A part number such as 1.5 is refused, and the message says so. **Minimum spacing between cells on an area plan** is the one setting that takes a fraction.
- **History** holds **Longest export (days)**: the most days one [export of readings](history.md#exporting-readings) may cover, 14 unless you change it, from 1 to 366. A longer window is refused, with the limit named. Lowering it changes nothing already exported.
- **Retention** holds how long things are kept. It also holds **Longest suppression window (days)**: the most days a [suppression window](devices.md#suppression-windows) may last, 7 unless you change it, from 1 to 90. A longer window is refused when someone schedules it or changes its times. Lowering it leaves the windows already scheduled as they are.
- **Enabled / Disabled** switches turn scheduled jobs on and off. A change takes effect the next time the job runs, and does not undo anything already done.
- **Cold Storage** here holds the archive threshold and the read-only site key. The archive destination, and the switch that turns archiving on, are set in one dialog on the Cold Storage page, so they are not listed here.
- **A read-only setting** shows **Set by** and where it is set, in a greyed field, and **Fixed at install** in Actions. The Sparkplug group and the archive site key are fixed when Aber is installed, and cannot be changed here. Changing the group would change the address of every gateway.
- **Security** holds **Require MFA to change the platform**. It is off when Aber is installed. Only an Administrator can turn it on or off.
- While it is on, an Administrator or a Shopfloor Manager needs [MFA](../guides/glossary.md#mfa-multi-factor-authentication) to change anything: a save, an approval, a new credential, a change on People. They need it to sign in to Node-RED, Studio and the forge too.
- Reading is never refused, and Grafana, Operators and Auditors are never asked. Someone refused is told to add an authenticator on **Profile › MFA**.
- **Turning it on signs every Administrator and Shopfloor Manager out of Node-RED and the forge, and Studio where your site runs it.** Their next sign-in there asks for MFA. Grafana stays signed in.
- Turning it off needs MFA too, once it is on. Add an authenticator on your **Profile** page first.
- **When the page is narrow** each setting stacks. The name and key come first, then the value and actions, then the description.

## The Notifications tab

This tab says where Aber sends each alert, besides the dashboard. There are two places: a webhook,
which is an address on your network, or a chat service's, that receives a message for each alert; and
email, which goes to the people in the roles you choose.

**To set up the webhook** (an Administrator):

1. Select **Set up the webhook** at the right of the toolbar.
2. Type the address the receiver gave you. It is stored in the vault and never shown again.
3. Under **Allowed hosts**, list the address's host, such as `hooks.example.net`. The dialog offers
   to add it for you.
4. Select **Save**.
5. Select **Issue signing key**, then **Issue Key**. Copy the key into the receiver: it is shown
   once.
6. Select **Send a test**. A toast says how it went, and the delivery log gets a row.

**To set up email** (an Administrator):

1. Check the page does not say that email cannot be sent yet. If it does, your site has no mail
   relay. The person who runs Aber sets one in the deployment, the same one that sends password
   resets.
2. Select **Set up email** at the right of the toolbar.
3. Tick the roles to tell, then select **Save**. Nobody is emailed until you tick one.
4. Select **Email a test**. It sends one message to your own address, and a toast says how it went.

Everyone with a ticked role who has an email address on their account is emailed. The lowest severity
emailed is a row of the table below, **Lowest severity emailed**. A message is sent when an alert
starts firing, as a reminder while it fires and nobody has acknowledged it, and when it resolves. The
subject names the severity, the alert, what it is about and which of those it is. The body says when
it started, the values it carried and where to open it in Aber. Nobody sees another person's address.

An alert about a machine identity's token is emailed to Administrators only, and only if you ticked
Administrator.

**What is sent to the webhook, and when:**

- **A message when an alert starts firing, and one when it resolves.** Only an alert at the lowest
  severity the webhook sends, or above, is sent.
- **A reminder** every **Remind every (hours)**, 12 by default, while the alert fires and nobody has
  acknowledged it. Acknowledging an alert stops its reminders. Its resolve is still sent.
- **A suppressed alert waits.** While a [suppression window](devices.md#suppression-windows) covers
  it, its message stays **Waiting** in the log. If it still fires when the window ends, the message
  is sent then. If it fires and resolves inside the window, nothing is sent.
- **No alert about a machine identity's token is sent to the webhook.** Only an Administrator can see
  those, and the webhook's readers are not known.
- **Each message is signed** with the signing key, so the receiver can check it came from this site.
  **Rotate signing key** makes a new one, and the old one stops working at once. Give the receiver the
  new key straight away.

**The delivery log** lists the newest 50 messages, newest first, for every role. Each row says when
it was queued, what it was about and what became of it:

- **Sent**: the receiver accepted it. For an email, it says how many people the mail relay took it
  for. The log never shows an address.
- **Waiting** or **Retrying**: it is queued, or a post failed and it is tried again. A message is
  tried for about three hours before it is marked **Failed**.
- **Not sent**: it no longer applied when it was due. For example, the alert resolved or was
  acknowledged first, or no one was left to email.
- **Last error** says why a post or an email failed, such as an answer that was not a success, a
  redirect, a host that is not allowed, or a mail relay that refused it. It never shows an address.

Only an Administrator sees the toolbar and the webhook's allowed hosts. Every role sees who is
emailed, the lowest severities, the reminder interval and the log.

## What the states mean

- A setting shows the value in force now.
- A change takes effect without a restart. It overrides the environment default that the setting names.
- Some settings limit a background job, such as pruning, tiering or retention. Changing one changes what the job does on its next run. It does not reach back and undo what the job already did.
- The list is fixed. A setting is here because Aber's code reads it, so new settings arrive with the feature that needs them. Nobody adds one by hand.

## What is not here

**Nothing secret is stored on this page.** Passwords, keys and broker credentials are not settings. They are kept in the deployment's own secret store. The S3 secret keys are set in the destination dialogs on the Cold Storage and Backups pages. Broker credentials are issued on Access Control. The webhook's address is set in its dialog on the Notifications tab, and its signing key is shown once. Keeping secrets apart means a routine settings change never looks like a credential change in the Audit Trail.

Alert thresholds are not here either. They are set in Grafana's alert rules, which Grafana checks. Aber links to the rules rather than copying them, so there is only one place a threshold can be wrong. Aber keeps the record of each alert that fired, with who acknowledged it and any [suppression window](devices.md#suppression-windows) that covered it. The alerts that fired are listed on the History page's **Alerts** tab. How long they are kept is a setting here: **Alert history kept for (days)**, on the **Retention** tab, 90 days unless you change it.
