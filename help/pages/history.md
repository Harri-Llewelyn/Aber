## What this page is for

History shows a site's readings over a period you choose. Open it to see how a device has behaved: whether a temperature crept up overnight, when a spindle stopped, or what a reading was last Tuesday.

The page opens on **Overview**, its first tab. It shows where readings arrived from every device over the window, before anything is charted. The other tabs:

- **Device** draws one chart for each metric of one device, stacked down the page on the same time axis. Point at a chart to read the value at that moment; every chart shows the same moment. Otherwise each chart's title line shows its latest reading.
- **Metric** compares one metric across every device that reports it, wherever the devices sit. See [The Metric tab](#the-metric-tab-one-metric-across-devices).
- **Cell** compares one metric across every machine in a cell. A chart for each machine sits on the same scale, so the odd one stands out. Below them, a grid shows the metric's mean at each hour of the day. See [The Cell tab](#the-cell-tab-comparing-the-machines-in-a-cell).
- **Area** compares one metric across the cells in an area. Each cell's chart is its mean or its total. See [The Area tab](#the-area-tab-comparing-the-cells-in-an-area).
- **Alerts** lists every alert that fired over the window, with who acknowledged it and why. See [Alerts](#alerts).

Everyone who can sign in can open History. Each lane and chart shows only what your account may read.

## The Overview: where readings arrived

1. Open **History** in the sidebar, directly below the Site Map. The Overview opens on **Last 24 hours**.
2. Each device has a **lane**, laid out as on the Audit Trail's timeline. On the left is a column of names: the device's tick box, its status dot, its name and how many metrics it reports. On the right is its strip across the window, under the time axis.
3. The strip is a row of **blocks**. The more readings arrived in a block, the more its blue stands out: darker in the light theme, lighter in the dark one. The key above the lanes reads **No readings**, then **Fewer readings → More readings**. Each strip is shaded against its own busiest block.
4. **Point at a block** to read it in words, below the block, for example **10:05–10:10 · 412 readings**, or **No readings**.
5. Read the line above the lanes for the block size, for example **48 devices, in 5-minute blocks**.

The strip never shows a reading's value, only how many arrived. A lane says **No readings since 15:00** when a device's readings stop inside the window. Machines send a reading only when a value changes, so a steady machine can be quiet for hours. The status dot says whether the device is online, and an offline device says **Offline**.

The lanes are grouped as the Site Map places devices: each area and its cells, the cells in no area, then **Site-Wide**, **Simulated** and **Unassigned**. Each group's heading is in the column of names, a cell's a step in from its area's. Archived devices are not shown. With many devices the lanes scroll inside the card, and the time axis and the headings stay in view.

The strips follow the Audit Trail's time axis, after the column of names, so they do not line up with the Device tab's charts.

- **Select a group's name**, such as **Boardroom · 4 devices**, to close it. A closed group draws one strip, its devices' readings added together.
- **Select Collapse all or Expand all**, at the start of the line above the lanes, to close or open every group.
- This browser remembers which groups you opened and closed. On a first visit every group is open, unless there are more than 200 devices. Then every group starts closed.
- **Type in the search box** to show only the devices whose name, id, cell or area matches.

The part of the window after now is hatched and says **No readings yet**. A crosswise hatch marks a stretch the historian has not counted yet. After an upgrade it counts older history in the background, and the line above the lanes says so, for example **Coverage before 3 Oct is still being computed**.

### Charting or zooming from Overview

1. Press on a strip and drag across the lanes and the stretch of time you want. A box follows the pointer, and the time axis says what it holds, for example **3 devices · 10:05 – 14:20, 4 h 15 min**.
2. Let go. The box stays, and a panel opens beside it with what it holds, **Chart**, **Zoom**, **Export CSV** and **Clear**.
3. Select **Zoom** to show that stretch on Overview. **Back** in your browser undoes it.
4. Or select **Chart**, over the box's stretch. For one device it opens that device's charts on the Device tab. For several it opens the [Metric tab](#the-metric-tab-one-metric-across-devices), narrowed to those devices, on the metric most of them report.
5. Or select **Export CSV** to save the box's devices, every metric they report, over the box's stretch. [Exporting readings](#exporting-readings) says who may and how long a stretch can be.

Select **Clear**, press **Escape**, or press anywhere outside the panel to clear the box. Scrolling the lanes clears it too.

You don't need to drag. Tick the box at the start of a lane to pick that device, and select **Chart** or **Export CSV** in the toolbar: they take the time window. The time window's **Zoom in** and **Zoom out** work here as on the Device tab. A lane's name also opens its charts.

### Long windows and many devices

The block size depends on how many devices Overview shows:

- **40 devices or fewer** get about one block for every 4 pixels of the strip, at any window up to a year. A block is never shorter than 5 minutes, so a short window has few blocks.
- **More than 40** get 5-minute blocks up to a day and 1-hour blocks up to 7 days. A longer window is not shown, and the page says why. To see one, type a cell's name in the search box, or narrow the list to 40 devices or fewer.

### How far back Overview reaches

Overview reaches as far back as the historian keeps its readings counted. You don't choose where it reads from: it picks by the age of each block.

- **5-minute blocks** reach back as far as the 1-minute summaries, 180 days by default.
- **1-hour blocks** reach back as far as the hourly summaries, 5 years by default.
- **An older day is shown in 1-hour blocks**, even where it would otherwise get 5-minute ones. The line above the lanes says so, for example **20 devices, in 1-hour blocks**. The 5-minute counts for that day are no longer kept.

The newest few minutes are counted a little after they arrive, so the right-hand end of a lane is hatched as not counted yet for a moment.

## Choosing a device and a window

1. Open **History** in the sidebar, directly below the Site Map, and select the **Device** tab. It lists every device.
2. Type in the search box to find a device by its name, its id, its cell or its area. Select its name.
3. Choose the period in the **time window**, after the device's name. It opens on **Last 24 hours**.
4. To chart another device, select its name in the toolbar and pick one from the list.

You can also start from a device. On the Devices page, open the device and select **View History**.

The time window works as it does on the Audit Trail: see [Moving through time](audit-trail.md#moving-through-time). Choose **Day**, **Week**, **Month** or **Year** to see a whole span, and **‹** or **›** to step back or forward. Select the words between the arrows to jump to a day, or to pick a rolling or custom range. There is no **All time**, because a chart must fit a size you can read. To look closer, zoom in: see [Zooming in on a stretch](#zooming-in-on-a-stretch).

## Choosing metrics and buckets

1. Select **Metrics** in the toolbar and tick the metrics you want to chart. It starts at **All metrics**. A long list has a search box.
2. Select **Buckets** to choose the bucket size. It starts at **Auto**, the smallest size that fits.
3. Select **Clear filters** to go back to **Last 24 hours**, every metric and **Auto**. The device stays.

The line above the charts says what you see, for example **3 of 10 metrics, in 1-minute buckets**.

Choosing fewer metrics gives smaller buckets, and so finer detail. Under **Auto**, the page picks the bucket size for the metrics you chose, not for all of them. See [Which bucket size you see](#which-bucket-size-you-see).

The address keeps the device, the window, the metrics and the bucket size, so a link you share opens the same charts. When you chart another device, it keeps the metrics it also has.

## Charts grouped by type

1. Select a group's name, such as **String**, to close it. Its charts are hidden.
2. Select the name again to open it.
3. Select **Collapse all** or **Expand all**, at the start of the line above the charts, to close or open every group.

The charts are grouped by the type of value each metric holds, as the Metrics page names it, in this order: **Double**, **Float**, the whole numbers (**Int8** to **UInt64**), **Boolean**, **String** and **Text**, then any other type. A metric the Metrics page does not list is under **Other**, last. Each group's name says how many charts it holds.

With many charts, they scroll inside the card. The line above them stays in view, and so does the name of the group you are scrolling through.

Closing a group only hides its charts. The **Metrics** filter, the bucket size and what the page reads stay the same. This browser remembers which groups you closed, on every device's page, but a link you share opens them all. The **Metrics** list in the toolbar is grouped the same way.

## Zooming in on a stretch

1. Press on a chart, or on a state's strip, and drag across the stretch you want. A shaded band follows the pointer, on every chart.
2. Read the band's words, such as **10:05 – 10:40, 35 min**. They say what the charts will show.
3. Let go. The charts show that stretch, in smaller buckets where the shorter window allows.
4. To go back to the window before, select **Back** in your browser.

Or use the buttons after **Day | Week | Month | Year**:

- **Zoom in** shows the middle half of the window.
- **Zoom out** shows a window twice as long, around the same middle. A window that would run past now ends at the current minute instead.

**Zoom in** stops at a window of one minute, and is greyed out there. Point at a button to see why it is greyed out.

A few things to know:

- **A drag must move at least 4 pixels.** A shorter one is a click, and changes nothing.
- **Press Escape during a drag** to cancel it.
- **On a touch screen, dragging scrolls the page.** Use the buttons to zoom.
- **A band shorter than one minute opens as one minute**, around its middle.
- **A zoomed window is a custom range,** so the arrows are called **Earlier** and **Later**.
- **Each zoom is a new step in your browser's history,** so **Back** undoes it. Stepping with **‹** or **›** adds no step.
- **A zoom keeps the metrics and the bucket size you chose.**

## Refreshing

1. Select **Refresh** to read the readings again now. The charts stay on screen while it reads.
2. To refresh by itself, choose how often in the list joined to **Refresh**: **Off**, **30 s**, **1 min** or **5 min**. It starts at **Off**.

Refreshing by itself works only while the window reaches now, such as **Last 24 hours** or today. A window that has ended, such as last Tuesday, cannot gain a reading, so the list is off and says why. **Refresh** still works.

## What a chart shows

Each chart is titled with the metric's name, with its unit in brackets when the Metrics page gives it one. A unit shows as its symbol, such as **°C** for CELSIUS and **mm** for MILLIMETER, in the title, the readings and the scale. A unit with no symbol shows as the Metrics page names it. The CSV export keeps that name, because other programs read it.

- **Latest**, at the right of the title line, is the newest reading in the window, for example **Latest 21.3 °C · 4 Nov 12:40**. The time is the start of the bucket the reading arrived in, not the moment it was sent. A carried bucket never counts, so a quiet machine shows its last real reading. A window with only carried buckets says **No reading in this window**. A text or flag chart showing every change says since when its value has held instead.
- **Pointing at a chart** shows that bucket instead: its time, its average, and its lowest to highest reading.

- **A bucket** is a stretch of time, such as five minutes. A reading arrives whenever the machine sends one, which can be many times a minute. So each chart groups the readings into buckets of equal length, and draws one point for each.
- **The line** is each bucket's average.
- **The shaded band** around it runs from the bucket's lowest reading to its highest. A narrow band means the reading held steady; a wide one means it moved within the bucket.
- **A dashed line** means no reading arrived in those buckets. Machines send a reading only when a value changes, so a quiet stretch means the value stayed the same. The dashed line carries the last reading forward until the next one arrives. This is called **carried forward**.
- **The valid range** is a dotted line labelled **valid range**, where the device's schema sets a lowest or highest value. It is not an alarm limit. A reading outside it usually means a faulty sensor or a schema that is wrong for the machine. The range is also written beside the chart's title.
- **A flag**, a value that is true or false, steps between the two. It steps at the moment the value changed: see [Text and flags: every change](#text-and-flags-every-change).
- **A state**, such as **ACTIVE** or **READY**, is a strip of boxes, one for each stretch the device held that state, with its name inside. A state's colour comes from its name, so it is the same on every chart and every device, and a new name gets a colour of its own. Two states can have similar colours, and a colour means nothing about the state, so the name is always written inside the box. A hatched part of a box was carried forward. A box too narrow for its name keeps its colour only.
- **The key** under a state's strip lists each state with its colour and its share of the charted time, the most first. Time after now does not count. The key names the six states with the most time; the rest are counted together as **others**.
- **Pointing at a state's strip** shows the stretch under the pointer, for example **4 Nov 10:05 – 10:40 · RUNNING, 35 min**, and how much of it was carried forward. A stretch of a few seconds is found from a few pixels away.
- **Now** marks the present moment on a window that runs on past it, such as today's. The part after it is hatched and says **No readings yet**.
- **A shaded red stretch** means an alert on the device was firing then. A solid line marks where it started and where it ended, when that is inside the window. Its name is written inside the stretch when there is room. Point at it to read which alert it was, its severity and when it fired. Several alerts at once shade the same stretch more deeply.
- **The line above the charts** then also says how many alerts fired in the window, for example **Shaded while an alert was firing: 2 alerts in this window**. Select it to list them on the [Alerts](#alerts) tab. A state's strip is not shaded.

A chart with nothing to draw says **No readings in this window, and none before it**.

## Derived metrics

A derived metric is one Aber computes from others, such as parts per hour. Its chart, and its name wherever you choose a metric, carry a **Derived** tag. No machine sent its values, so you will not find them in an export.

- **Which devices.** The Device, Cell, Metric and Area tabs offer a derived metric on every device that reports all its inputs. The Metric tab's list counts those devices.
- **How it is drawn.** A rate is how many the counter grew by in an hour. A time in state is the share of the bucket spent in its states, shown as a percentage of the bucket with one decimal at most, such as 42% or 42.5%. A sum adds its inputs minute by minute, and the bucket is the average of those minutes.
- **A device that lacks an input has no value.** No partial sum is drawn. The Area tab's cells follow its rule: a cell's total is drawn only where every machine has a value.
- **It is read from the minutes.** Time in state is resolved to the minute. A counter that resets and then climbs back past its old value inside one minute is counted short by that old value.
- **A wide bucket's sum need not equal the sum of its inputs' averages.** An input's average weighs its readings, and a quiet input has few of them. A derived sum weighs every minute alike.
- **A long window can be too long.** A derived metric is read from the minutes, so a window of many months, or of many devices, is refused. The chart says so. Choose a shorter window or fewer devices.
- **Two things do not apply.** The hour-of-day grids read measured metrics, so they say so for a derived one. **Export CSV** leaves a derived metric out and says why. Export its inputs. A metric is listed when the device declared it the last time it started, or when one of its schemas includes it.

## Which bucket size you see

Under **Auto**, the page picks the bucket size for you, and says which it chose above the charts, for example **15 metrics, in 5-minute buckets**. There are four sizes:

- **1-minute buckets**
- **5-minute buckets**
- **1-hour buckets**
- **1-day buckets**

The page picks the smallest size that keeps one read to at most 5,000 points. A point is one bucket of one metric. So a longer window, or more metrics, gets larger buckets. For example, one metric over 24 hours fits in 1-minute buckets, but 15 metrics over the same day get 5-minute buckets. To see finer detail, choose fewer metrics or a shorter window.

**Buckets** also offers each size. A larger size than **Auto** picks is always on. A smaller one would need more than 5,000 points, so it is listed but off; point at it to see why. A link that asks for one is charted at the size **Auto** picks, and the line above the charts says so.

**Text charts get wider buckets under Auto.** In small buckets, the names in a state's strip run together and cannot be read. So under **Auto**, a text chart, such as a state, takes the smallest size whose buckets are each at least 3 pixels wide on the chart. A narrow screen or a long window gets larger buckets. Text and flag charts usually show every change instead, whatever the bucket size: see [Text and flags: every change](#text-and-flags-every-change). The buckets are what they fall back to.

When even 1-day buckets would be too many for all the metrics at once, the page reads them in parts and says so. A window too long for one metric in 1-day buckets is not charted, and the page asks for a shorter one.

## Text and flags: every change

A text chart, such as a state, and a flag chart show **every change**, each at the moment it happened. A state the device held for ten seconds is drawn at its own time, even on **Last 24 hours**. The line above the charts says so, for example **3 metrics, in 5-minute buckets; text and flags show every change**.

- **A state's box** runs from the moment the device reported that state to the moment it reported the next one.
- **A flag** steps at the moment it changed.
- **Pointing at either** shows the stretch to the second, for example **4 Nov 10:05:12 – 10:05:47 · false, 35 s**.
- **Latest**, at the right of the title line, says since when the value has held, for example **Latest RUNNING · since 4 Nov 12:40:05**.
- **A hatched or dashed start** is the value carried in from before the window, up to the first reading in it.

Every change needs the readings exactly as the device sent them, the raw readings. The historian keeps raw readings for 14 days by default, and its summaries for much longer. Machines also send an unchanged value again every few minutes, and those repeats are left out.

### When a chart shows its buckets instead

A text or flag chart shows **the last value in each bucket** instead in three cases:

- **More than 2,000 changes** of one metric in the window.
- **More than 20,000 readings** of one metric in the window, such as a value sent every second whether it changed or not.
- **The window is older than the raw readings kept.**

The line above the charts says which, for example **text and flags show the last value in each 1-hour bucket, past the 2,000-change cap**. A chart that shows something different from that line says so in its own title line.

A bucket shows only the last value in it. So in the first two cases, the page also marks each bucket that held more than one value:

- **On a state's strip**, the bucket is dotted along its foot. The key says **more than one value in the bucket**. Point at it to read how many values it held, for example **10:05 – 10:10 · 3 values in this bucket, RUNNING last**.
- **On a flag's chart**, the bucket is shaded from false to true, and pointing at it says **both values in this bucket**.

To see every change again, zoom in, or choose a shorter window. A window older than the raw readings has no marks, because the summaries keep only each bucket's last value.

**Export CSV** is not affected. Its **Raw samples** are every reading, changes and repeats alike.

## Exporting readings

Only an **Administrator** or a **Shopfloor Manager** can export. For anyone else, **Export CSV** is greyed and says **Requires Administrator or Shopfloor Manager**. The charts are unchanged.

1. Choose what to export. On the Device tab, choose the device, the window and the metrics, as above. The export saves what the charts show. On Overview, draw a box or tick the devices. On the Cell tab, choose the cell, the metric and the window. On the Area tab, choose the area, the metric and the window. The file holds each machine behind the charts, not the cells' means or totals. On the Metric tab, choose the metric, the filters and the window. The file holds every device the tab lists, on every page.
2. Select **Export CSV** in the toolbar, or in Overview's panel. The dialog's first line says what it will save, for example **Lathe 3 · 3 metrics · Last 24 hours (4 Nov 12:41 – 5 Nov 12:41)**. The times are fixed when the dialog opens.
3. Choose the **Resolution**, then select **Export CSV** in the dialog. The file downloads, and a message links to the export's entry in the Audit Trail.

The file has one row for each reading: its **time**, **device**, **metric**, **value** and **unit**. Its first line names the resolution, because the file is what gets passed on.

The resolutions:

- **Raw samples**, the one the dialog starts on, is every reading as the machine sent it.
- **1 minute**, **5 minutes** and **1 hour** are summaries: one row for each period, with its start as the time and its average as the value. A text or a flag has no average, so its row holds the period's last value.

Each resolution says how far back it has data, because raw readings are kept for much less time than the summaries. If the window starts before the resolution you chose begins, the dialog says so, names the finest resolution that covers the whole window, and offers to switch. It never swaps in a summary by itself. A raw file that starts later than the window says so in its first lines.

**Buckets** changes only the charts. The export has its own **Resolution**.

### How much one export can hold

- **A window of at most 14 days.** An Administrator can change the limit in **Settings**, on the **History** tab. If the window is longer, **Export CSV** is greyed and says how long the limit is. On Overview, the box's words say **over the 14-day export limit** while you draw it. Choose a shorter window, or read older history from Cold Storage's files.
- **An export holds at most 50,000 rows.** If there are more, the file stops at a whole minute, and the message and the file's first lines say where. Choose a shorter window, fewer devices or metrics, or a coarser resolution.
- **At most 1,000 devices and 500 metrics.**

If a second factor is required to change the platform, exporting asks for it too. Each export is recorded in the Audit Trail, in the **Readings** lane. The entry names who exported. It lists the devices and metrics, the window and the resolution. It also says how many rows left.

## The Metric tab: one metric across devices

The Metric tab shows one metric across every device that reports it, wherever the devices sit. Use it for a question such as "how do the bearing temperatures of all our lathes compare?", when the lathes are in several areas.

1. Select the **Metric** tab under the page's name. It lists the metrics that some device in service reports, with their units as symbols and how many devices report each.
2. Select a metric's name. Or select **Chart** after you pick several devices on Overview: the tab opens on the metric most of them report.
3. Choose the period in the **time window**. **Zoom in**, **Zoom out** and a drag across a chart work as on the Device tab.
4. To narrow the devices, select **Filters** and tick areas, cells or devices. Each list offers only what reports the metric. A device in no cell and no area is left out as soon as you choose any area or cell.
5. To compare another metric, select its name in the toolbar. It keeps the window and the filters.

Each device has a chart, in name order. Its title line carries the device's status dot, its name, and where it sits, for example **Turning · Hall B**. Select the name to open that device's charts on the Device tab. Every chart uses the same scale and the same time axis, as on the Cell tab. A text or flag metric is drawn as a strip for each device, showing every change. A shaded red stretch means an alert on that device was firing.

The page reads every device at once, in the smallest buckets that keep the read to at most 5,000 points. The line above the charts says which, for example **20 devices, in 1-hour buckets**. A point is one bucket of one device, so more devices get larger buckets.

### Many devices

Sometimes one read cannot carry all the devices, even in 1-day buckets. Then the tab shows them a page at a time, 12 devices to a page. It does the same for more than 200 devices, which are too many charts for one page. The line above the charts says so, for example **57 devices are too many to chart at once, so they come 12 to a page: devices 13 to 24.** Select **Next** or **Previous** under the charts to turn the page.

Each page has its own scale, and says so: **One scale for every device on this page.** To compare devices on different pages, narrow the list with **Filters** until they fit on one.

## The Cell tab: comparing the machines in a cell

The Cell tab shows one metric across every machine in a cell. Use it to find the machine that behaves differently from the rest.

1. Select the **Cell** tab under the page's name. It lists the cells.
2. Select a cell's name. Or open the cell on the Cells page and select **View History**.
3. Choose the **metric** in the toolbar. It starts on the metric most of the cell's machines report. The list says how many machines report each metric.
4. Choose the period in the **time window**. **Zoom in**, **Zoom out** and a drag across a chart work as on the Device tab.
5. To compare another cell, select its name in the toolbar. It keeps the window, and the metric where the other cell reports it.

The tab has two sections. Select a section's name to close it, or **Collapse all** to close both. Both sections show the machines in service in the cell. An archived device is not shown.

### Over the window

- **Each machine has a chart.** Its title line carries the machine's status dot and its name. Select the name to open that machine's charts on the Device tab. An offline machine says **Offline**.
- **Every chart uses the same scale.** The line above the charts says what it is, for example **One scale for every machine: 13.9 to 88.1 kW**. A machine that runs harder than the rest stands out, because all the charts are drawn to the same height.
- **Every chart shares the time axis.** Point at one chart to read the value at that moment. Every chart shows the same moment.
- **A machine that does not report the metric** gets a line in words instead of a chart, for example **Press 1 does not report Spindle/LOAD.**
- **A text or flag metric** is drawn as on the Device tab: a strip for each machine, showing every change. See [Text and flags: every change](#text-and-flags-every-change).
- **A shaded red stretch** means an alert on that machine was firing. See [What a chart shows](#what-a-chart-shows).

The page reads every machine at once, in the smallest buckets that keep the read to at most 5,000 points. The line above the charts says which, for example **20 machines, in 5-minute buckets**. A point is one bucket of one machine, so more machines get larger buckets. When even 1-day buckets would be too many, the page reads the machines in parts and says so.

### By hour of the day

The grid has a row for each machine and a column for each hour, **00** to **23**. Each cell is coloured by the metric's mean at that hour across the days in the window.

- **The hours are in your browser's time zone.** The line above the grid names it, for example **Europe/London**. Across a clock change, an hour moves with the clock.
- **A lighter or darker blue means a higher value,** lighter in the dark theme and darker in the light one. The key above the grid says which values each shade stands for, for example **20 to 40.75 kW**. **No value** is an hour with no reading to show.
- **One scale covers every machine,** so one machine's busy hour shows against the others'.
- **Point at a cell, or move to it with the arrow keys,** to read it in words under the grid, for example **Lathe 3 · 14:00–15:00 · 54 kW, the mean of 7 days**.
- **A quiet hour counts as the last value.** Machines send a reading only when a value changes, so a steady machine holds its last value. The mean counts that value for the hour.
- **Every hour weighs the same,** however many readings it held.
- **A text or flag metric has no mean.** The grid says it needs a number.

The grid reads one hourly summary for each hour of the window for each machine, at most 50,000 in all. For a cell of 20 machines, that is at most 104 days. A longer window says so, and the charts above it are not affected. Choose a shorter window, or a cell with fewer machines.

In a time zone that is offset by part of an hour, such as India's, each hourly summary starts at half past the hour. It is counted in the hour it starts in.

## The Area tab: comparing the cells in an area

The Area tab shows one metric across the cells in an area. It is the Cell tab one level up: a chart for each cell, not for each machine. Use it to see which cell runs harder or hotter than the others.

1. Select the **Area** tab under the page's name. It lists the areas.
2. Select an area's name. Or open the area on the Areas page and select **View History**.
3. Choose the **metric** in the toolbar. It starts on the metric most of the area's machines report.
4. Choose how each cell is drawn with **Mean** or **Total**, beside the metric. It starts on **Mean**.
5. Choose the period in the **time window**. **Zoom in**, **Zoom out** and a drag across a chart work as on the Device tab.
6. To compare another area, select its name in the toolbar. It keeps the window, the metric and the choice of mean or total.

The tab has two sections. Select a section's name to close it, or **Collapse all** to close both. Both show the cells in service in the area. An archived cell is not shown. A device that is Area-Wide belongs to no cell, so it is in no chart, and the line above the charts says how many.

### Over the window

- **Each cell has a chart.** Its title line carries the cell's name and how many machines it has. Select the name to open that cell on the Cell tab, over the same window and metric.
- **Mean** draws the mean of the cell's machines that have a value in each bucket.
- **Total** draws the sum of the cell's machines, but only for a bucket in which every machine has a value. A sum of some of them would read as the real one. Where a total is withheld, the chart has no point. It says so in words, for example **total of 3 machines, withheld from 10:05 to 10:35, where a machine had no value**. A cell that never has a full set says so instead of drawing a chart.
- **A machine counts when it reports the metric.** A machine that does not is left out of its cell's figure.
- **Every chart uses the same scale,** said above the charts, for example **One scale for every cell: 6.6 to 56.4 kW**. Every chart shares the time axis.
- **A cell none of whose machines reports the metric** gets a line in words instead of a chart.
- **A text or flag metric has no mean or total.** The tab says it needs a number, and offers each cell's own tab, where it is drawn as a strip for each machine.
- **A shaded red stretch** means an alert on any machine of the cell was firing.

The page reads every machine at once. The data is combined into cells where it is kept, so the buckets can be finer than the Cell tab's for the same machines. The line above the charts says which, for example **4 cells, each the mean of its machines that have a value, in 5-minute buckets**. A window too long for the area, even in 1-day buckets, is not charted, and the page asks for a shorter one.

### By hour of the day

The grid has a row for each cell and a column for each hour, **00** to **23**. Each square is the cell's mean at that hour across the days in the window, in your browser's time zone. It is the mean of the cell's machines' own means, so each machine weighs the same.

The key, the shades, the scale and the reading in words work as on the Cell tab. A square reads, for example, **Turning · 14:00–15:00 · 34 kW, the mean of 7 days, across 3 machines**. The grid stays the mean when you choose **Total**.

The grid reads one hourly summary for each hour of the window for each machine, at most 50,000 in all. For an area of 20 machines, that is at most 104 days. A longer window says so, and the charts above it are not affected.

## Alerts

The **Alerts** tab lists every alert that fired over the window, newest first. An alert that started before the window and was still firing in it is listed too.

1. Select **Alerts** under the page's name. It opens on **Last 24 hours**.
2. Choose the period in the **time window**, as on the Device tab. **Zoom in** and **Zoom out** work here too.
3. To see only some devices' or gateways' alerts, select **Asset** and tick them. It starts at **Every asset**.
4. Type in the search box to find an alert by its name, its summary, what it is about, or who acknowledged it.
5. Select a column's name to sort by it. Select it again to reverse the order, and a third time to go back to newest first.

You can also start from the alert counter in the top bar: select **Alert history** at the foot of its list. From a device's charts, select the number of alerts in the line above them.

Each row says:

- **Alert**: its name, with the summary it was raised with.
- **Severity**: **Critical**, **Warning** or **Info**.
- **Subject**: the device or gateway it was about. Select it to open its panel on the Devices or Gateways page. An alert about the whole platform says **Platform-wide**.
- **Started** and **Ended**: when it started and stopped firing. **Firing** means it still is.
- **Duration**: how long it fired, or how long so far.
- **Acknowledged**: who acknowledged it, the reason, when, and their note. A dash means nobody did. Acknowledging is done from the alert counter: see [The alert counter](site-map.md#the-alert-counter).

A few things to know:

- **An alert that fired again without first resolving** ends where the next one started. Its **Ended** says **(fired again)**. Point at it to see why.
- **Suppressed**, with a crossed-out bell under an alert's name, means a [suppression window](devices.md#suppression-windows) covered it while it fired. For that time it was not counted, and nothing was sent.
- **The list shows at most 1,000 alerts.** When more fired, the line above the list says so. Choose a shorter window or fewer assets.
- **Alerts are kept for 90 days.** An Administrator can change that on the **Settings** page: **Alert history kept for (days)**, on the **Retention** tab. A window older than that lists none, and the page says so. Who acknowledged an alert stays in the Audit Trail after the alert is gone.
- **Only an Administrator sees an alert about a machine identity's token.** For anyone else, an empty list says **No alert you may see fired in this window**.
- **Refresh** and its timer work as on the Device tab.
- **The address keeps the window, the assets and the search**, so a link you share opens the same list.

## What the states mean

- **Loading readings…** means the page is reading the device's metrics. A long window takes longer.
- **The readings could not be read** names what went wrong. Usually the database that holds the readings could not be reached. Select **Refresh** to try again.
- **No device answers to this address** means the link names a device that no longer exists. Select **Choose another device**.
- **No cell answers to this address** means the link names a cell that no longer exists. Select **Choose another cell**.
- **No device is in service in this cell** means every device in it is archived, or none has been placed there.
- **The heatmap needs a number** means the metric is text or a flag. Its charts show every change, and the grid has nothing to average.
- **This device has declared no metrics** means it has not started up since it was registered, and no schema attached to it lists any metric.
- **Loading alerts…** means the Alerts tab is reading the alerts in the window.
- **No alert fired in this window** means just that. With assets chosen, it says **No alert fired on the assets chosen in this window**.
- **The alerts could not be read** names what went wrong. Select **Refresh** to try again.

Nothing on this page changes anything.
