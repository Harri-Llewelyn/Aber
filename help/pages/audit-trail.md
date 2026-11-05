## What this page is for

The Audit Trail records what changed, who changed it, and what it looked like before. Use it to find out when something was changed, and by whom. Every modelling action in Aber is a row here: creating a gateway, assigning a schema, archiving a device or editing a setting. Rows cannot be edited or deleted afterwards.

Each entity has a lane on the timeline, and each change is a marker on that lane. The lanes are grouped in sections, one for each kind of entity.

## What the controls do

- **The search box** matches a name or an id. It takes the three ids shown in the event drawer: an entity ID, a mutation ID or a transaction ID. A term made only of digits also matches a mutation ID and a transaction ID. A deleted entity can be found by its name too, because the trail keeps the name it had.
- **The time window** after the search box sets the stretch of time the timeline shows. **All time** is the default. [Moving through time](#moving-through-time) says how to use it.
- **Zoom in** and **Zoom out**, after **Day | Week | Month | Year**, narrow or widen the window. You can also drag across the timeline. [Zooming in on a stretch](#zooming-in-on-a-stretch) says how.
- **Filters** opens the filters used less often: the kind filter, the action filter, **Changed by** and **Show deleted entities**. Its number is how many of them are set, and its own **Clear** resets just those.
- **Inside Filters, each list opens and closes.** Select a list's name to open it. The list that was open closes, so one is open at a time. A closed list still says what is ticked in it, such as **Action · 2 chosen**, or the name of the one value ticked. A name too long for the heading is cut short. Point at the heading, or move to it, to see the whole name. When Filters opens, the first list with something ticked is open, or else the first list.
- **Each of the three lists takes several values.** Tick every value you want: a row is listed if it matches any of them. Ticking nothing shows them all. The lists combine, so a row must pass each one that is set. Each list is grouped, and ticking a group's heading ticks the whole group. A long list has a search box.
- **The kind and action lists show a count beside each value.** It is how many events that value has under your other filters: the search, the window, the other lists, the key's classes and **Show deleted entities**. A list's own ticks are left out of its own counts, so ticking one action does not empty the action list. A value that can occur but has no events shows 0.
- **Each list offers only what can occur with your other choices.** Tick **Cells**, and the action list drops the backup actions, which never happen to a cell. Tick **Backup taken**, and the kind list drops every kind it cannot happen to. The classes you choose in the key narrow the action list the same way.
- **A value you ticked stays in its list, even when it no longer fits.** It is greyed, and says what it cannot occur with, such as "not with Cells" or "never Read". The timeline is then empty. Untick it to bring the events back.
- **The kind filter** narrows the timeline to kinds of entity, grouped as the timeline groups them: the plant (areas, cells, gateways, devices, alerts), the model, capture and security. It does not pick out one entity. For one entity's history, paste its name or id into the search box. Or open the Audit Trail from that entity's page, which fills in the search box for you. From a device, that also shows its nameplate and schema changes.
- **The action filter** narrows the timeline to database actions across every entity. That is Insert, Update, Delete, or a named act such as Token minted or Proposal applied. They are grouped by what the act is about, such as row changes, people and access, or backups. The four reads are a group of their own, **Reads**. The key's classes are a separate filter: an action says how the change was recorded, and a class says what it did.
- **Changed by** narrows the timeline to the changes the people and machine identities you tick made. People are listed by name and email address, and machine identities by name. It follows the account, not the address. So a person who changed their email address shows all their changes, old and new.
- **While Changed by is set**, a chip in the bar names who you chose, or the first and how many more. Select the chip to show everyone's changes again. To get here from a person, select **View Their Changes** in their drawer on **Access Control › People**.
- **Only an Administrator or an Auditor sees people in Changed by.** Other roles see only the machine identities Aber comes with. Each role sees only the rows it may read, whoever it picks.
- **Show deleted entities**, in **Filters**, brings back the rows for things no longer in the database, such as a deleted schema or a deleted cell. They are hidden by default, so the page shows the plant as it stands now. Their records are kept either way. The number beside it is how many entities it would show. It appears only when there is something to show.
- **Clear filters** puts every control back to its default, including the deleted entities toggle and the key's classes. Its number is how many controls are changed.
- **Export CSV** saves the events loaded on the page. The changes are flattened into one column. Its number says how many events are loaded and, when more match, how many match in all. To export them all, load the rest first.
- **The key**, at the right-hand end of the row above the timeline, says what each marker means. Each class has its own shape as well as its own colour, so you can tell them apart without colour vision. A circle is **Operational**, the most common. A square is **Created**, and a diamond is **Configuration**. A triangle is **Lifecycle**: deletes, archives and quarantines. A grey eye is **Read**: someone looked at something or took a copy, and nothing changed.
- **Each class in the key is also a filter.** Select a class to show only its events, and select another to add it. Select a class again to leave it out. With none selected, every class shows. The number beside a class is how many events it has under your other filters. The address keeps the classes, so a link you share opens with the same ones.
- **Grouped** is a violet badge with a count. It replaces markers too close together to draw apart. Hover over it for a breakdown, or [zoom in](#zooming-in-on-a-stretch) and the markers separate. Its entry in the key is not a filter.
- **A section heading**, such as **Devices · 12**, names a kind of entity and counts its lanes. Select it to close the section, and again to open it. A closed section keeps one track, holding every change of its lanes. Select a marker or a badge on that track to open the change, and the section opens with it.
- **Collapse all**, at the start of the key's row, over the section headings, closes every section. While every section is closed it reads **Expand all**, and opens them all. Every section starts open. Aber remembers which sections you closed in this browser, so they stay closed when you come back.
- **A lane's name** opens the drawer on the newest change to that entity. Then **Previous**, or ←, steps back through its history. An entity with no name is labelled by a short form of its ID. Point at a lane's name to see the whole name and the entity's ID. A name too long for its column is cut short, and slides to show the rest while you point at it.
- **The event drawer** opens when you click a marker. It shows when the change was recorded, the actor, the entity ID, the mutation ID, the transaction ID and the description. **Previous** and **Next**, or ← and →, step through that lane's history. **Previous Entity** and **Next Entity**, or ↑ and ↓, move to the entity above or below, at the same point in time. They skip the entities in a closed section. Above the buttons, "Event 3 of 7 · Entity 4 of 23" says where you are.
- **Property** and **Previous** in the drawer show the field that changed and the value it held before. Together they answer "when did this become wrong?".
- **Same transaction** lists the other rows written by the same act. **Show whole transaction** loads all of them, by searching for the transaction ID. The section appears only when the act wrote something else, or may have. When Aber cannot count the act's rows, the section says so.
- **The step buttons** run across the drawer's full width, under its title. **Previous** and **Next** are on the first row, and **Previous Entity** and **Next Entity** under them.
- **User ID** names the person who made the change, and **Machine identity** names the machine. An Administrator can select the name to open that person or machine on the **Access Control** page. Select the ID beside the name to copy it.
- **View in Devices**, at the foot of the drawer, opens the entity on its own page. It reads **View in Gateways**, **View in Cells**, **View in Areas** or **View in Schemas** for those kinds. A deleted entity has no page, so it has no such button.
- **Raw audit payload** opens the entry exactly as it was recorded, for when the summary is not enough.
- **A read of a service's logs** over a fixed window shows the window as one row, in your local time, such as "3 Nov 09:00 – 4 Nov 09:00". The raw payload keeps its two ends in UTC, as they were recorded.
- **Show more** at the foot loads the next 200 events, older than those already loaded. Beside it is the number loaded out of the number that match, such as "200 of 242". **All N shown.** appears once every matching event is loaded. Under **All time** the page loads 200 events at first. Any other window loads every event in it by itself, up to 2,000, as [Moving through time](#moving-through-time) says.
- The page **refreshes itself** every 60 seconds, unless an Administrator changed that on the Settings page. A refresh adds new events at the top, and keeps the pages you already loaded.

## Moving through time

1. Choose **Day**, **Week**, **Month** or **Year** in the bar. The timeline shows the whole of that span, around the date shown.
2. Select **‹** or **›** to step back or forward one span at a time.
3. To go further, select the date between the arrows. Under **Jump to**, choose **Today** to come back to now, or a day such as **A month ago**. Or pick any date and select **Jump**.

The span stays as it was when you jump. In **Week**, **A month ago** shows the week that holds that day. Weeks start on Monday.

The same list has two other kinds of window:

- **Rolling** shows the last 15 minutes, hour, day, week or month, ending now. **All time** shows everything.
- **Custom range** takes two dates and times, then **Show range**. The range stops at the start of the minute you give as its end.

Under a rolling or custom range, no span is chosen. The arrows are called **Earlier** and **Later**, and step by the range's own length. Stepping a rolling range fixes it: **Last 1 hour** at 15:20, stepped back, shows 13:20 to 14:20. Choosing a span then shows the day, week, month or year that holds the end of the range.

**›** is greyed out while the window reaches now, and both arrows are greyed out under **All time**. Point at an arrow, or move to it with Tab, to see why.

When the window runs on past now, as today's does, the axis shows **Now** and the time. The part after it is hatched and says **Nothing recorded yet**.

A window loads every event in it by itself, 200 at a time, up to 2,000 events. The foot says **Loading…** until it has them. A window that holds more than 2,000 loads the newest 2,000. Its start is then hatched and says **Older events not loaded: more than 2,000 in this window**, or **Not loaded: over 2,000** where the hatched part is narrow. **Show more** at the foot loads older ones, 200 at a time. The page stops at 2,000 so that a busy month stays quick to draw.

The address keeps the window, so a link you share opens the same one.

## Zooming in on a stretch

1. Press on the axis, or on an empty part of a lane, and drag across the stretch you want. A shaded band follows the pointer.
2. Read the band's words on the axis, such as **10:05 – 10:40, 35 min**. They say what the timeline will show.
3. Let go. The timeline shows that stretch, and its badges split into markers as they move apart.
4. To go back to the window before, select **Back** in your browser.

Or use the buttons after **Day | Week | Month | Year**:

- **Zoom in** shows the middle half of the window. Under **All time**, it shows the middle half of the events drawn.
- **Zoom out** shows a window twice as long, around the same middle. A window that would run past now ends at the current minute instead.

**Zoom in** stops at a window of one minute, and is greyed out there. **Zoom out** is greyed out under **All time**, which already shows everything. Point at a button to see why it is greyed out.

A few things to know:

- **A press on a marker or a badge still opens it.** A drag starts only on the axis or an empty part of a track.
- **A drag must move at least 4 pixels.** A shorter one is a click, and changes nothing.
- **Press Escape during a drag** to cancel it.
- **On a touch screen, dragging scrolls the page.** Use the buttons to zoom.
- **A band shorter than one minute opens as one minute**, around its middle.
- **A zoomed window is a custom range,** so the arrows are called **Earlier** and **Later**.
- **Each zoom is a new step in your browser's history,** so **Back** undoes it. Stepping with **‹** or **›** adds no step, so **Back** does not replay every step.

## What the states mean

**The Audit Trail is deliberately not the logs.** Entries here are only ever added, each is linked to an actor, and none can be changed once written. Container and pod logs are none of those things. They are for diagnosing faults, and they are lost when the container is recreated. Anything that matters for audit is recorded here as a row.

**Captures and playbacks have lanes of their own.** Recordings, Captures and Playbacks record who started or stopped a recording, stored, downloaded or deleted a capture, and started or stopped a playback. A capture's deletion says why it went: deleted, replaced, or deleted with its gateway or device. Each lane is named after the machine that was recorded, followed by when that recording, capture or playback began, so two recordings of one machine can be told apart. In a window of one day the time is a clock time alone; in a wider window the date comes first. Two that began in the same minute show the seconds too. Point at the name to see the lane's own ID. Their progress is not recorded.

**An alert's acknowledgements have a lane of their own**, under **Alerts** in the plant's section. The lane is named after the alert and the device or gateway it is about. Each row says who acknowledged it or withdrew it, the reason and the note. An alert about a machine identity is the exception: its acknowledgements are in that identity's lane, which only an Administrator or an Auditor can read.

**Aber decides each event's class, not the page.** The first rule that fits decides:

1. **Read**: a service's logs read on the System page, a gateway's credential shown again, a capture's download link issued, and a device exported.
2. **Operational**: an alert acknowledged from the alert counter, or its acknowledgement withdrawn.
3. **Configuration**: every other change in the security lane, which is people, access, machine identities, apps, settings and backups. Also a schema rejection, a token minted or revoked, and a schema attached to or detached from a device.
4. **Created** for something made, and **Lifecycle** for something deleted. A recording or playback started counts as made, and a capture deleted as deleted.
5. For any other change, what changed decides. Archived, quarantined or deprecated is **Lifecycle**. A schema, configuration, connection method or address that changed is **Configuration**. Anything else is **Operational**.

**Not every entry is visible to every role.** The trail has a security lane, for role assignments, machine identities, settings, backups and reads of a service's logs. Only an Administrator or an Auditor can read it. Other roles see the plant's lanes, and the kind filter does not offer them the security kinds.

Rows are kept until an owner retires a whole month. Nothing removes old rows on a timer. Whoever runs the database retires history on purpose, by detaching a month's partition. The steps are in [Trimming the Audit Trail](../../deploy/k8s/README.md#trimming-the-audit-trail).
